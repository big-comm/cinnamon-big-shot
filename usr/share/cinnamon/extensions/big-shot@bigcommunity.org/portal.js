/**
 * Big Shot — XDG ScreenCast portal client
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const BUS_NAME = 'org.freedesktop.portal.Desktop';
const OBJECT_PATH = '/org/freedesktop/portal/desktop';
const SCREENCAST_IFACE = 'org.freedesktop.portal.ScreenCast';
const REQUEST_IFACE = 'org.freedesktop.portal.Request';
const SESSION_IFACE = 'org.freedesktop.portal.Session';

function _token(prefix) {
    return prefix + '_' + GLib.get_monotonic_time().toString() + '_' +
        Math.floor(Math.random() * 0x1000000).toString(16);
}

function _call(connection, interfaceName, method, parameters, replyType) {
    return new Promise((resolve, reject) => {
        connection.call(
            BUS_NAME,
            OBJECT_PATH,
            interfaceName,
            method,
            parameters,
            replyType,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (source, result) => {
                try {
                    resolve(source.call_finish(result));
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

var ScreenCastPortal = class ScreenCastPortal {
    constructor() {
        this._connection = Gio.DBus.session;
        this._sessionHandle = null;
        this._fdList = null;
        this._fdIndex = -1;
        this._sessionClosedId = 0;
        this.stream = null;
        this.closed = false;
    }

    async start(sourceTypes, includeCursor) {
        let availableTypes = await this._getUintProperty(
            'AvailableSourceTypes'
        );
        if ((availableTypes & sourceTypes) === 0)
            throw new Error('Requested ScreenCast source type is unavailable');
        let availableCursorModes = await this._getUintProperty(
            'AvailableCursorModes'
        );
        let cursorMode = includeCursor && (availableCursorModes & 2)
            ? 2
            : 1;
        if (!(availableCursorModes & cursorMode))
            throw new Error('No supported ScreenCast cursor mode is available');

        let create = await this._request('CreateSession', null, {
            session_handle_token: new GLib.Variant('s', _token('session')),
        });
        this._sessionHandle = String(create.session_handle || '');
        if (!this._sessionHandle.startsWith('/'))
            throw new Error('ScreenCast portal returned no session handle');

        this._sessionClosedId = this._connection.signal_subscribe(
            BUS_NAME,
            SESSION_IFACE,
            'Closed',
            this._sessionHandle,
            null,
            Gio.DBusSignalFlags.NONE,
            () => { this.closed = true; }
        );

        await this._request('SelectSources', this._sessionHandle, {
            types: new GLib.Variant('u', sourceTypes),
            multiple: new GLib.Variant('b', false),
            cursor_mode: new GLib.Variant('u', cursorMode),
        });
        let started = await this._request(
            'Start',
            this._sessionHandle,
            {}
        );
        let streams = started.streams || [];
        if (!Array.isArray(streams) || streams.length !== 1)
            throw new Error('ScreenCast portal returned no usable stream');
        let item = streams[0];
        let properties = item[1] || {};
        this.stream = {
            nodeId: Number(item[0]),
            serial: properties['pipewire-serial'] !== undefined
                ? String(properties['pipewire-serial'])
                : null,
            position: properties.position || null,
            size: properties.size || null,
            sourceType: Number(properties.source_type) || 0,
        };
        await this._openPipeWireRemote();
        return this.stream;
    }

    async _getUintProperty(name) {
        let reply = await _call(
            this._connection,
            'org.freedesktop.DBus.Properties',
            'Get',
            new GLib.Variant('(ss)', [SCREENCAST_IFACE, name]),
            new GLib.VariantType('(v)')
        );
        let value = reply.get_child_value(0).get_variant();
        return Number(value.deepUnpack()) || 0;
    }

    async _request(method, sessionHandle, options) {
        let handleToken = _token('request');
        options = Object.assign({}, options || {}, {
            handle_token: new GLib.Variant('s', handleToken),
        });
        let sender = this._connection.get_unique_name()
            .substring(1)
            .replace(/\./g, '_');
        let requestPath = '/org/freedesktop/portal/desktop/request/' +
            sender + '/' + handleToken;

        let signalId = 0;
        let responsePromise = new Promise((resolve, reject) => {
            signalId = this._connection.signal_subscribe(
                BUS_NAME,
                REQUEST_IFACE,
                'Response',
                requestPath,
                null,
                Gio.DBusSignalFlags.NONE,
                (connection, senderName, objectPath, interfaceName,
                    signalName, parameters) => {
                    connection.signal_unsubscribe(signalId);
                    let unpacked = parameters.deepUnpack();
                    if (Number(unpacked[0]) !== 0) {
                        reject(new Error('ScreenCast portal request was denied'));
                        return;
                    }
                    resolve(unpacked[1] || {});
                }
            );
        });

        let parameters;
        if (method === 'CreateSession') {
            parameters = new GLib.Variant('(a{sv})', [options]);
        } else if (method === 'SelectSources') {
            parameters = new GLib.Variant('(oa{sv})', [
                sessionHandle,
                options,
            ]);
        } else {
            parameters = new GLib.Variant('(osa{sv})', [
                sessionHandle,
                '',
                options,
            ]);
        }
        try {
            await _call(
                this._connection,
                SCREENCAST_IFACE,
                method,
                parameters,
                new GLib.VariantType('(o)')
            );
        } catch (e) {
            if (signalId)
                this._connection.signal_unsubscribe(signalId);
            throw e;
        }
        return await responsePromise;
    }

    _openPipeWireRemote() {
        return new Promise((resolve, reject) => {
            this._connection.call_with_unix_fd_list(
                BUS_NAME,
                OBJECT_PATH,
                SCREENCAST_IFACE,
                'OpenPipeWireRemote',
                new GLib.Variant('(oa{sv})', [this._sessionHandle, {}]),
                new GLib.VariantType('(h)'),
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                null,
                (source, result) => {
                    try {
                        let finished = source.call_with_unix_fd_list_finish(result);
                        let reply = finished[0].deepUnpack();
                        this._fdList = finished[1];
                        this._fdIndex = Number(reply[0]);
                        if (!this._fdList || this._fdIndex < 0)
                            throw new Error('Portal returned no PipeWire file descriptor');
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    takeDuplicateFd(targetFd) {
        if (!this._fdList || this._fdIndex < 0 || this.closed)
            throw new Error('PipeWire portal session is not available');
        let duplicates = new Gio.UnixFDList();
        duplicates.append(this._fdList.get(this._fdIndex));
        let fds = duplicates.steal_fds();
        if (!fds || fds.length !== 1)
            throw new Error('Could not duplicate the PipeWire file descriptor');
        return { fd: fds[0], targetFd: targetFd };
    }

    close() {
        if (this._sessionClosedId) {
            this._connection.signal_unsubscribe(this._sessionClosedId);
            this._sessionClosedId = 0;
        }
        if (this._sessionHandle && !this.closed) {
            this._connection.call(
                BUS_NAME,
                this._sessionHandle,
                SESSION_IFACE,
                'Close',
                null,
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                null
            );
        }
        this.closed = true;
        this._sessionHandle = null;
        this._fdList = null;
        this._fdIndex = -1;
    }
};

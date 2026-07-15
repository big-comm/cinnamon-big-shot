#!/usr/bin/python3
"""Own the clipboard and serve screenshots in image and file formats."""

import ctypes
import os
from pathlib import Path
import sys


class TargetEntry(ctypes.Structure):
    _fields_ = [
        ("target", ctypes.c_char_p),
        ("flags", ctypes.c_uint),
        ("info", ctypes.c_uint),
    ]


if len(sys.argv) not in (2, 3):
    raise SystemExit(2)

path = os.path.abspath(sys.argv[1])
delete_on_clear = len(sys.argv) == 3 and sys.argv[2] == "--delete-on-clear"
uri = Path(path).as_uri()
with open(path, "rb") as png_file:
    png = png_file.read()

formats = {
    0: (b"image/png", png),
    1: (b"x-special/gnome-copied-files", ("copy\n" + uri).encode()),
    2: (b"text/uri-list", (uri + "\r\n").encode()),
}
targets = (TargetEntry * len(formats))(
    *(TargetEntry(mimetype, 0, info)
      for info, (mimetype, _data) in formats.items())
)

gtk = ctypes.CDLL("libgtk-3.so.0")
gdk = ctypes.CDLL("libgdk-3.so.0")

gdk.gdk_atom_intern.argtypes = [ctypes.c_char_p, ctypes.c_int]
gdk.gdk_atom_intern.restype = ctypes.c_void_p
gtk.gtk_clipboard_get.argtypes = [ctypes.c_void_p]
gtk.gtk_clipboard_get.restype = ctypes.c_void_p
gtk.gtk_clipboard_set_with_data.argtypes = [
    ctypes.c_void_p,
    ctypes.POINTER(TargetEntry),
    ctypes.c_uint,
    ctypes.c_void_p,
    ctypes.c_void_p,
    ctypes.c_void_p,
]
gtk.gtk_clipboard_set_with_data.restype = ctypes.c_int
gtk.gtk_selection_data_set.argtypes = [
    ctypes.c_void_p,
    ctypes.c_void_p,
    ctypes.c_int,
    ctypes.c_void_p,
    ctypes.c_int,
]
gtk.gtk_selection_data_set.restype = None
gtk.gtk_main.argtypes = []
gtk.gtk_main.restype = None
gtk.gtk_main_quit.argtypes = []
gtk.gtk_main_quit.restype = None

GetFunc = ctypes.CFUNCTYPE(
    None, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p
)
ClearFunc = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_void_p)


@GetFunc
def provide_data(_clipboard, selection, info, _data):
    mimetype, data = formats[info]
    atom = gdk.gdk_atom_intern(mimetype, 0)
    buffer = ctypes.create_string_buffer(data)
    gtk.gtk_selection_data_set(selection, atom, 8, buffer, len(data))


@ClearFunc
def clipboard_cleared(_clipboard, _data):
    if delete_on_clear:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
    gtk.gtk_main_quit()


if not gtk.gtk_init_check(None, None):
    raise SystemExit(1)

clipboard_atom = gdk.gdk_atom_intern(b"CLIPBOARD", 0)
clipboard = gtk.gtk_clipboard_get(clipboard_atom)
if not gtk.gtk_clipboard_set_with_data(
    clipboard, targets, len(targets), provide_data, clipboard_cleared, None
):
    raise SystemExit(1)

gtk.gtk_main()

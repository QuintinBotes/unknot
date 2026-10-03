// Top-level names of the Python standard library (3.9 through 3.13), so the linker can
// tell `import json` from `import requests` without ever asking an interpreter.

export const STDLIB = new Set((
  '__future__ _thread abc aifc argparse array ast asyncio atexit audioop base64 bdb binascii bisect builtins bz2 '
  + 'cProfile calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall concurrent '
  + 'configparser contextlib contextvars copy copyreg crypt csv ctypes curses dataclasses datetime dbm decimal '
  + 'difflib dis distutils doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput '
  + 'fnmatch fractions ftplib functools gc genericpath getopt getpass gettext glob graphlib grp gzip hashlib heapq '
  + 'hmac html http idlelib imaplib imghdr imp importlib inspect io ipaddress itertools json keyword lib2to3 '
  + 'linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap modulefinder msilib msvcrt '
  + 'multiprocessing netrc nis nntplib ntpath nturl2path numbers opcode operator optparse os ossaudiodev pathlib '
  + 'pdb pickle pickletools pipes pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd '
  + 'py_compile pyclbr pydoc pydoc_data pyexpat queue quopri random re readline reprlib resource rlcompleter '
  + 'runpy sched secrets select selectors shelve shlex shutil signal site smtpd smtplib sndhdr socket socketserver '
  + 'spwd sqlite3 sre_compile sre_constants sre_parse ssl stat statistics string stringprep struct subprocess sunau '
  + 'symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile termios textwrap this threading time timeit '
  + 'tkinter token tokenize tomllib trace traceback tracemalloc tty turtle turtledemo types typing unicodedata '
  + 'unittest urllib uu uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xdrlib xml xmlrpc '
  + 'zipapp zipfile zipimport zlib zoneinfo _io _collections_abc _weakref'
).split(' '));

/** Import name -> PyPI distribution name where the two differ (common cases only). */
export const DIST_ALIASES = Object.freeze({
  yaml: 'pyyaml', PIL: 'pillow', cv2: 'opencv-python', sklearn: 'scikit-learn', bs4: 'beautifulsoup4',
  dateutil: 'python-dateutil', jwt: 'pyjwt', dotenv: 'python-dotenv', attr: 'attrs', OpenSSL: 'pyopenssl',
  psycopg2: 'psycopg2-binary', MySQLdb: 'mysqlclient', Crypto: 'pycryptodome', serial: 'pyserial',
  magic: 'python-magic', ruamel: 'ruamel.yaml', skimage: 'scikit-image', git: 'gitpython', zmq: 'pyzmq',
});

/** PEP 503 normalisation: case-insensitive, runs of `-_.` equal one `-`. */
export function normalizeDist(name) {
  return String(name).toLowerCase().replace(/[-_.]+/g, '-');
}

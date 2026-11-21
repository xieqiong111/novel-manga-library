#!/usr/bin/env python3
"""Export one CBZ per completed Suwayomi manga chapter."""

import argparse
import base64
from contextlib import closing, contextmanager
from decimal import Decimal
import fcntl
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from itertools import islice
import logging
import math
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import tempfile
import time
from threading import Thread
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile


NUMBER = r"[0-9]{1,4}"
VOLUME = re.compile(
    rf"^\s*(?:第\s*)?(?P<cjk>{NUMBER})\s*[卷巻册冊](?=$|[^0-9])"
    rf"|^\s*vol(?:ume)?\.?\s*(?P<en>{NUMBER})(?=$|[^0-9])",
    re.IGNORECASE,
)
BOUNDARY = re.compile(r"^[\s.·:：_—–\-（(\[【]+")
CHAPTER_LABEL = re.compile(
    r"^(?:第\s*(?P<cjk>\d+(?:\.\d+)?)\s*[话話章节節回]|ch(?:apter)?\.?\s*(?P<en>\d+(?:\.\d+)?))",
    re.I,
)
BARE_CHAPTER = re.compile(r"^(?P<number>[0-9]{1,4}(?:\.[0-9]{1,4})?)(?=$|[\s话話章节節回:：、._—-])")
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp", ".jxl"}
DIGITS = str.maketrans("０１２３４５６７８９", "0123456789")
SERIES_MARKER = ".studio-series.json"
PAGE_SIZE = 100
CATALOG_LIMIT = 5000
CHAPTER_FIELDS = "id name isDownloaded pageCount"
ARCHIVE_LIMIT = 2 * 1024**3


class ArchiveError(Exception):
    pass


class DownloadHistory:
    def __init__(self, root):
        self.root = root
        self.file = root / ".studio-download-history.sqlite3"
        if self.file.is_symlink():
            raise ArchiveError("invalid download history database")
        with closing(self.connect()) as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS completed (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, chapterId TEXT NOT NULL UNIQUE,
                    mangaId TEXT NOT NULL, title TEXT NOT NULL, chapterName TEXT NOT NULL,
                    observedAt INTEGER NOT NULL, archiveState TEXT NOT NULL, file TEXT
                );
                CREATE INDEX IF NOT EXISTS completed_manga ON completed(mangaId, seq);
                CREATE TABLE IF NOT EXISTS exports (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, mangaId TEXT NOT NULL, file TEXT NOT NULL
                );
            """)
        self.file.chmod(0o600)

    def connect(self):
        db = sqlite3.connect(self.file, timeout=3)
        db.row_factory = sqlite3.Row
        return db

    def remember(self, manga, chapter, state, file=None, written=False):
        chapter_id, manga_id = str(chapter["id"]), str(manga["id"])
        relative = file.relative_to(self.root).as_posix() if file else None
        with closing(self.connect()) as db, db:
            previous = db.execute(
                "SELECT title,chapterName,archiveState,file FROM completed WHERE chapterId = ?", (chapter_id,)
            ).fetchone()
            fields = (manga["title"], chapter["name"], state, relative)
            if previous and tuple(previous) == fields and not written:
                return
            db.execute("""
                INSERT INTO completed(chapterId,mangaId,title,chapterName,observedAt,archiveState,file)
                VALUES(?,?,?,?,?,?,?) ON CONFLICT(chapterId) DO UPDATE SET
                  title=excluded.title, chapterName=excluded.chapterName, archiveState=excluded.archiveState, file=excluded.file
            """, (chapter_id, manga_id, manga["title"], chapter["name"], int(time.time()*1000), state, relative))
            # Existing CBZs imported into history do not trigger an unsolicited bulk scrape.
            if state == "archived" and (written or (previous and previous["archiveState"] in ("waiting_archive", "archive_failed"))):
                db.execute("INSERT INTO exports(mangaId,file) VALUES(?,?)", (manga_id, relative))

    def page(self, before, limit, manga_id):
        with closing(self.connect()) as db:
            rows = db.execute("""
                SELECT * FROM completed WHERE (? IS NULL OR seq < ?) AND (? IS NULL OR mangaId = ?)
                ORDER BY seq DESC LIMIT ?
            """, (before, before, manga_id, manga_id, limit+1)).fetchall()
        return {"history": [dict(row) for row in rows[:limit]],
                "nextBefore": rows[limit-1]["seq"] if len(rows) > limit else None}

    def events(self, after):
        with closing(self.connect()) as db:
            rows = db.execute("SELECT * FROM exports WHERE seq > ? ORDER BY seq LIMIT 100", (after,)).fetchall()
        return {"events": [dict(row) for row in rows]}


class RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Suwayomi:
    def __init__(self, config):
        base = config.get("LN_SUWAYOMI_URL") or config.get("SUWAYOMI_URL") or ""
        parsed = urlsplit(base)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username is not None
                or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
            raise ArchiveError("Suwayomi URL must be an HTTP(S) origin")
        self.base = base.rstrip("/")
        self.opener = build_opener(ProxyHandler({}), RejectRedirects())
        user = config.get("LN_SUWAYOMI_USERNAME") or config.get("SUWAYOMI_USERNAME") or ""
        password = config.get("LN_SUWAYOMI_PASSWORD") or config.get("SUWAYOMI_PASSWORD") or ""
        if bool(user) != bool(password):
            raise ArchiveError("Suwayomi Basic authentication needs both username and password")
        self.headers = {}
        if user:
            credentials = base64.b64encode(f"{user}:{password}".encode()).decode()
            self.headers["Authorization"] = f"Basic {credentials}"

    @contextmanager
    def request(self, path, data=None):
        headers = dict(self.headers)
        if data is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(data).encode()
        try:
            with self.opener.open(Request(self.base + path, data, headers), timeout=30) as response:
                yield response
        except HTTPError as exc:
            exc.close()
            raise ArchiveError(f"Suwayomi HTTP {exc.code}") from None
        except (URLError, TimeoutError) as exc:
            raise ArchiveError(f"Suwayomi request failed ({type(exc).__name__})") from None

    def graphql(self, query, **variables):
        with self.request("/api/graphql", {"query": query, "variables": variables}) as response:
            try:
                payload = json.loads(response.read(4 * 1024**2))
            except (UnicodeError, ValueError):
                raise ArchiveError("Suwayomi returned invalid GraphQL JSON") from None
        if not isinstance(payload, dict) or payload.get("errors") or not isinstance(payload.get("data"), dict):
            raise ArchiveError("Suwayomi rejected the archive GraphQL query")
        return payload["data"]

    def chapters(self, condition, fields):
        # Conditions are fixed strings supplied by the caller, never source text.
        id_argument = ", $id: Int!" if "id" in condition else ""
        query = f"""query ArchiveChapters($offset: Int!{id_argument}) {{
          chapters(condition: {{ {condition['query']} }}, first: {PAGE_SIZE}, offset: $offset) {{
            nodes {{ {fields} }} pageInfo {{ hasNextPage }}
          }}
        }}"""
        offset = 0
        arguments = {"id": condition["id"]} if "id" in condition else {}
        while True:
            result = self.graphql(query, offset=offset, **arguments).get("chapters")
            if (not isinstance(result, dict) or not isinstance(result.get("nodes"), list)
                    or not isinstance(result.get("pageInfo", {}).get("hasNextPage"), bool)):
                raise ArchiveError("Suwayomi returned incomplete chapter pagination")
            nodes = result["nodes"]
            yield from nodes
            if not result["pageInfo"]["hasNextPage"]:
                return
            if not nodes:
                raise ArchiveError("Suwayomi returned empty intermediate chapter page")
            offset += len(nodes)

    def download_status(self):
        data = self.graphql("""query ArchiveDownloadProgress {
          downloadStatus { state queue { state progress chapter { id mangaId name } } }
        }""").get("downloadStatus")
        if not isinstance(data, dict) or not isinstance(data.get("queue"), list):
            raise ArchiveError("Suwayomi returned an incomplete download queue")
        queue = []
        for task in data["queue"]:
            chapter = task["chapter"]
            progress = task["progress"]
            if progress is not None and (not isinstance(progress, (int, float)) or not 0 <= progress <= 1):
                raise ArchiveError("Suwayomi returned invalid download progress")
            queue.append({
                "mangaId": str(chapter["mangaId"]), "chapterId": str(chapter["id"]), "chapterName": chapter["name"],
                "state": task["state"], "percent": None if progress is None else math.floor(progress * 100 + 0.5),
            })
        return {"state": data["state"], "queue": queue}

    def downloaded_mangas(self):
        return {row["manga"]["id"]: row["manga"] for row in self.chapters(
            {"query": "isDownloaded: true"}, "manga { id title sourceId }"
        )}

    def manga(self, manga_id):
        return self.graphql("query($id: Int!) { manga(id: $id) { id title sourceId } }", id=manga_id)["manga"]

    def manga_chapters(self, manga_id):
        return self.chapters({"query": "mangaId: $id", "id": manga_id}, CHAPTER_FIELDS)

    def chapter_zip(self, chapter_id, output):
        with self.request(f"/api/v1/chapter/{int(chapter_id)}/download?markAsRead=false") as response:
            size = 0
            while chunk := response.read(1024**2):
                size += len(chunk)
                if size > ARCHIVE_LIMIT:
                    raise ArchiveError("chapter archive exceeds size limit")
                output.write(chunk)
        output.seek(0)


def chapter_number(name):
    name = name.translate(DIGITS).strip()
    labelled = CHAPTER_LABEL.match(name)
    if labelled:
        number = labelled["cjk"] or labelled["en"]
    else:
        bare = BARE_CHAPTER.match(name)
        number = bare["number"] if bare else None
    if number is None or not re.fullmatch(r"\d{1,4}(?:\.\d{1,4})?", number):
        return None
    return format(Decimal(number).normalize(), "f")


def standalone_chapters(chapters):
    for row in chapters:
        name = row["name"].translate(DIGITS)
        volume = VOLUME.match(name)
        if volume:
            number = chapter_number(BOUNDARY.sub("", name[volume.end():]))
            if number is None:
                continue
        else:
            number = chapter_number(name)
        yield number, row


def chapter_filename(number, chapter_id):
    if number is None:
        return f"章节 [{int(chapter_id)}].cbz"
    whole, dot, fraction = number.partition(".")
    return f"第{whole.zfill(3)}{dot}{fraction}话 [{int(chapter_id)}].cbz"


def chapter_archives(chapters):
    for number, row in standalone_chapters(chapters):
        if row["isDownloaded"] is True:
            yield chapter_filename(number, row["id"]), row["name"], number, [row]


def natural_key(value):
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", value, flags=re.ASCII)]


def series_identity(manga):
    return {"sourceId": int(manga["sourceId"]), "mangaId": int(manga["id"])}


def series_title(manga):
    title = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", manga["title"]).strip(" .")
    return title.encode()[:160].decode(errors="ignore").rstrip(" .") or "漫画"


def read_series_marker(folder):
    marker = folder / SERIES_MARKER
    try:
        if marker.is_symlink() or not marker.is_file():
            return None
        with marker.open("rb") as handle:
            return json.loads(handle.read(1024))
    except (OSError, UnicodeError, ValueError):
        return None


def series_directory(root, manga):
    identity = series_identity(manga)
    suffix = f" [{identity['sourceId']}-{identity['mangaId']}]"
    matches = []
    for entry in root.iterdir():
        legacy = entry.name.endswith(suffix)
        if entry.is_symlink():
            if legacy:
                raise ArchiveError(f"invalid archive directory for manga {identity['mangaId']}")
            continue
        if entry.is_dir() and (legacy or read_series_marker(entry) == identity):
            matches.append(entry)
    if len(matches) > 1:
        raise ArchiveError(f"ambiguous archive directory for manga {identity['mangaId']}")
    if matches:
        return matches[0]
    title = series_title(manga)
    plain = root / title
    return root / (title + suffix) if plain.exists() or plain.is_symlink() else plain


def prepare_series_folder(folder, manga):
    try:
        folder.mkdir(mode=0o700)
        folder.chmod(0o700)
    except FileExistsError:
        if folder.is_symlink() or not folder.is_dir():
            raise ArchiveError("invalid manga destination folder")
    marker = folder / SERIES_MARKER
    identity = series_identity(manga)
    try:
        with marker.open("x", encoding="utf-8") as handle:
            json.dump(identity, handle)
    except FileExistsError:
        if read_series_marker(folder) != identity:
            raise ArchiveError("existing folder belongs to a different series")


def comic_info(manga, title, number, page_count):
    info = ElementTree.Element("ComicInfo")
    for tag, value in [("Series", manga["title"]), ("Title", title),
                       ("Number", number), ("PageCount", str(page_count))]:
        ElementTree.SubElement(info, tag).text = value
    return ElementTree.tostring(info, encoding="utf-8", xml_declaration=True)


def add_chapter_pages(client, archive, chapter, first_page):
    with tempfile.TemporaryFile() as downloaded:
        client.chapter_zip(chapter["id"], downloaded)
        with ZipFile(downloaded) as source:
            pages = [item for item in source.infolist() if not item.is_dir()
                     and not any(part.startswith((".", "__MACOSX")) for part in PurePosixPath(item.filename).parts)
                     and PurePosixPath(item.filename).suffix.lower() in IMAGE_SUFFIXES]
            pages.sort(key=lambda item: natural_key(item.filename))
            expected = chapter["pageCount"]
            if not pages or (expected > 0 and len(pages) != expected):
                raise ArchiveError(f"chapter {chapter['id']} has {len(pages)} archive pages; expected {expected}")
            if sum(item.file_size for item in pages) > ARCHIVE_LIMIT or any(item.file_size <= 0 for item in pages):
                raise ArchiveError(f"chapter {chapter['id']} contains invalid image sizes")
            for index, item in enumerate(pages, first_page):
                suffix = PurePosixPath(item.filename).suffix.lower()
                with source.open(item) as image, archive.open(f"{index:06}{suffix}", "w") as output:
                    shutil.copyfileobj(image, output, 1024**2)
    return len(pages)


def archive_signature(chapters):
    return json.dumps({"version": 1, "chapters": [[row["id"], row["pageCount"]] for row in chapters]},
                      separators=(",", ":")).encode()


def storage_roots(root, settings):
    if not settings:
        return root, []
    try:
        data = json.loads(settings.read_text())
    except FileNotFoundError:
        return root, []

    def subfolder(relative):
        result = root
        for name in relative.split("/") if relative else []:
            if not name or name.startswith(".") or re.search(r"[\\:\x00-\x1f\x7f]", name):
                raise ArchiveError("invalid storage subfolder")
            result = result / name
            if result.is_symlink() or not result.is_dir():
                raise ArchiveError("storage subfolder unavailable")
        return result

    current = subfolder(data["mangaFolder"])
    previous = []
    for name in data["mangaPrevious"]:
        try:
            previous.append(subfolder(name))
        except ArchiveError:
            continue
    return current, previous


def archive_directories(root, previous, manga):
    return [series_directory(parent, manga) for parent in (root, *previous)]


def archive_path(directories, filename):
    for folder in directories:
        existing = folder / filename
        if existing.exists() or existing.is_symlink():
            return existing
    return directories[0] / filename


def archive_status(directories, filename, selected, failed):
    destination = archive_path(directories, filename)
    if destination.is_file() and not destination.is_symlink():
        try:
            with ZipFile(destination) as archive:
                if archive.comment == archive_signature(selected):
                    return {"filename": filename}
        except BadZipFile:
            return {"filename": None, "archiveFailed": True}
    return {"filename": None, **({"archiveFailed": True} if failed else {})}


def legacy_volume_chapters(directories):
    coverage = {}
    for folder in directories:
        for file in sorted(folder.glob("第*卷.cbz")):
            if file.is_symlink() or not re.fullmatch(r"第[0-9]{2,4}卷\.cbz", file.name):
                continue
            try:
                with ZipFile(file) as archive:
                    saved = json.loads(archive.comment)
                if isinstance(saved, dict) and saved.get("version") == 1 and isinstance(saved.get("chapters"), list):
                    for row in saved["chapters"]:
                        if isinstance(row, list) and len(row) == 2 and all(type(value) is int for value in row):
                            coverage.setdefault(tuple(row), file.name)
            except (BadZipFile, OSError, ValueError, UnicodeError):
                continue
    return coverage


def archive_catalog(client, root, manga_id, previous=(), *, offset=0, limit=20, chapter_ids=None, archive_errors=None):
    manga = client.manga(manga_id)
    if not manga or str(manga["sourceId"]) == "0":
        return {"volumes": [], "archiveMode": "unsupported", "chapters": [], "chapterCount": 0}
    chapters = list(islice(client.manga_chapters(manga_id), CATALOG_LIMIT + 1))
    if len(chapters) > CATALOG_LIMIT:
        raise ArchiveError("chapter catalog exceeds lookup limit")
    directories = archive_directories(root, previous, manga)
    legacy = legacy_volume_chapters(directories)
    standalone = list(standalone_chapters(chapters))
    mode = "chapter" if standalone else "unsupported"
    selected_chapters = ([(number, row) for number, row in standalone if str(row["id"]) in chapter_ids]
                         if chapter_ids is not None else standalone[offset:offset + limit])
    results = []
    for number, row in selected_chapters:
        filename = chapter_filename(number, row["id"])
        status = archive_status(directories, filename, [row], archive_errors and (manga_id, filename) in archive_errors)
        old_file = legacy.get((row["id"], row["pageCount"]))
        if not status["filename"] and old_file:
            status = {"filename": None, "legacyVolume": old_file}
        results.append({
            "id": str(row["id"]), "name": row["name"], "number": number, "downloaded": row["isDownloaded"],
            **status,
        })
    return {"volumes": [], "archiveMode": mode, "chapters": results, "chapterCount": len(standalone)}


def catalog_selection(query):
    params = parse_qs(query, keep_blank_values=True, strict_parsing=True, max_num_fields=3)
    if any(key not in ("chapterIds", "offset", "limit") or len(values) != 1 for key, values in params.items()):
        raise ValueError("invalid archive query")
    ids = params["chapterIds"][0].split(",") if "chapterIds" in params else None
    if ids is not None and (len(ids) > 100 or any(not re.fullmatch(r"[1-9][0-9]{0,9}", id_) for id_ in ids)):
        raise ValueError("invalid chapter IDs")
    offset, limit = int(params.get("offset", ["0"])[0]), int(params.get("limit", ["20"])[0])
    if not (0 <= offset <= CATALOG_LIMIT and 1 <= limit <= 100):
        raise ValueError("invalid archive pagination")
    return {"chapter_ids": set(ids) if ids is not None else None, "offset": offset, "limit": limit}


def history_query(query, *fields):
    values = parse_qs(query, keep_blank_values=True, strict_parsing=True, max_num_fields=len(fields))
    if any(key not in fields or len(items) != 1 or not re.fullmatch(r"0|[1-9][0-9]{0,14}", items[0])
           for key, items in values.items()):
        raise ValueError("invalid history pagination")
    return {key: int(items[0]) for key, items in values.items()}


def start_status_server(client, root, port, settings=None, archive_errors=None, history=None):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            self.request.settimeout(5)
            super().setup()

        def do_GET(self):
            url = urlsplit(self.path)
            match = re.fullmatch(r"/manga/([1-9][0-9]{0,9})/volumes", url.path)
            try:
                if self.path == "/downloads":
                    result = client.download_status()
                elif history and url.path in ("/history", "/archive-events"):
                    try:
                        if url.path == "/history":
                            params = history_query(url.query, "before", "limit", "mangaId")
                            limit = params.get("limit", 50)
                            if not 1 <= limit <= 100:
                                raise ValueError("invalid history page size")
                            before = params.get("before")
                            manga_id = str(params["mangaId"]) if "mangaId" in params else None
                            result = history.page(before, limit, manga_id)
                        else:
                            params = history_query(url.query, "after")
                            result = history.events(params.get("after", 0))
                    except ValueError:
                        self.send_error(400)
                        return
                elif match and int(match[1]) <= 2**31 - 1:
                    try:
                        selection = catalog_selection(url.query)
                    except ValueError:
                        self.send_error(400)
                        return
                    current, previous = storage_roots(root, settings)
                    result = archive_catalog(client, current, int(match[1]), previous, archive_errors=archive_errors, **selection)
                else:
                    self.send_error(404)
                    return
                body = json.dumps(result).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                return
            except (ArchiveError, OSError, ValueError, TypeError, KeyError, sqlite3.Error):
                self.send_error(503)

        def log_message(self, *_args):
            pass

    server = HTTPServer(("0.0.0.0", port), Handler)
    Thread(target=server.serve_forever, daemon=True).start()
    return server


def write_cbz(client, root, manga, filename, title, number, chapters, directories):
    destination = archive_path(directories, filename)
    folder = destination.parent
    signature = archive_signature(chapters)
    if len(signature) > 65535:
        raise ArchiveError("too many chapters for one volume archive")
    if destination.is_symlink():
        raise ArchiveError("existing CBZ is a symbolic link")
    if destination.exists():
        with ZipFile(destination) as current:
            if current.comment == signature:
                return False
            try:
                previous = json.loads(current.comment)
            except (UnicodeError, ValueError):
                raise ArchiveError("existing CBZ belongs to a different exporter") from None
            if not isinstance(previous, dict) or previous.get("version") != 1 or not isinstance(previous.get("chapters"), list):
                raise ArchiveError("existing CBZ belongs to a different exporter")
            current_ids = {row["id"] for row in chapters}
            if any(not row or row[0] not in current_ids for row in previous["chapters"]):
                raise ArchiveError("the source's chapter set shrank or changed edition; preserving the previous CBZ")
    with tempfile.NamedTemporaryFile(prefix=".suwayomi-", suffix=".tmp", dir=root, delete=False) as temporary:
        staging = Path(temporary.name)
        try:
            with ZipFile(temporary, "w") as output:
                page_count = 0
                for chapter in chapters:
                    page_count += add_chapter_pages(client, output, chapter, page_count + 1)
                output.writestr("ComicInfo.xml", comic_info(manga, title, number, page_count))
                output.comment = signature
            temporary.flush()
            os.fsync(temporary.fileno())
            staging.chmod(0o600)
            prepare_series_folder(folder, manga)
            os.replace(staging, destination)
        finally:
            staging.unlink(missing_ok=True)
    logging.info("exported %s in %s (%d pages)", destination.name, folder.name, page_count)
    return True


def run_once(client, root, previous=(), archive_errors=None, history=None):
    def record_error(key):
        if archive_errors is not None:
            if len(archive_errors) >= CATALOG_LIMIT:
                archive_errors.pop(next(iter(archive_errors)))
            archive_errors[key] = True

    def clear_error(key):
        if archive_errors is not None:
            archive_errors.pop(key, None)

    mangas = client.downloaded_mangas()
    failures = 0
    exported = 0
    for manga_id, manga in mangas.items():
        completed = []
        try:
            chapters = list(client.manga_chapters(manga_id))
            completed = [row for row in chapters if row["isDownloaded"]]
            directories = archive_directories(root, previous, manga)
            legacy = legacy_volume_chapters(directories)
            if history:
                eligible = {row["id"] for _, row in standalone_chapters(completed)}
                for row in completed:
                    if row["id"] not in eligible:
                        filename = legacy.get((row["id"], row["pageCount"]))
                        history.remember(manga, row, "legacy" if filename else "unsupported",
                                         archive_path(directories, filename) if filename else None)
            for filename, title, number, selected in chapter_archives(chapters):
                row = selected[0]
                old_file = legacy.get((row["id"], row["pageCount"]))
                if old_file:
                    if history:
                        history.remember(manga, row, "legacy", archive_path(directories, old_file))
                    continue
                key = (manga_id, filename)
                try:
                    destination = archive_path(directories, filename)
                    if history and not destination.exists():
                        history.remember(manga, row, "waiting_archive")
                    written = write_cbz(client, root, manga, filename, title, number or '', selected, directories)
                    exported += written
                    if history:
                        history.remember(manga, row, "archived", destination, written)
                    clear_error(key)
                except (ArchiveError, OSError, BadZipFile, RuntimeError) as exc:
                    record_error(key)
                    if history:
                        history.remember(manga, row, "archive_failed")
                    failures += 1
                    logging.error("manga %s chapter %s: %s", manga_id, selected[0]["id"], exc)
        except (ArchiveError, KeyError, TypeError, ValueError) as exc:
            if history:
                for row in completed:
                    history.remember(manga, row, "archive_failed")
            failures += 1
            logging.error("manga %s: %s", manga_id, exc)
    logging.log(logging.INFO if exported or failures else logging.DEBUG,
                "%d manga checked, %d CBZ exported, %d failures", len(mangas), exported, failures)
    return failures


def log_download_progress(client, interval):
    previous = {}
    unavailable = False
    while True:
        try:
            queue = client.download_status()["queue"]
            current = {task["chapterId"]: (task["state"], task["percent"]) for task in queue}
            for task in queue:
                if current[task["chapterId"]] != previous.get(task["chapterId"]):
                    logging.info("download %s", json.dumps(task, ensure_ascii=False))
            for chapter_id in previous.keys() - current.keys():
                logging.info("chapter %s left Suwayomi queue; check the archive output for CBZ confirmation", chapter_id)
            if unavailable:
                logging.info("Suwayomi download queue is reachable again")
            previous = current
            unavailable = False
        except (ArchiveError, OSError, ValueError, TypeError, KeyError) as exc:
            if not unavailable:
                logging.warning("cannot read Suwayomi download progress: %s", exc)
            unavailable = True
        time.sleep(interval)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--connection-file", type=Path, help="Suwayomi connection JSON (optional)")
    parser.add_argument("--interval", type=int, default=0, help="seconds between polls; zero runs once")
    parser.add_argument("--status-port", type=int, help="internal HTTP status port")
    parser.add_argument("--progress-interval", type=int, default=0, help="seconds between download progress checks")
    parser.add_argument("--settings-file", type=Path, default=os.environ.get("LN_DOWNLOAD_FOLDERS_FILE") or None)
    args = parser.parse_args()
    if args.progress_interval and (not args.interval or args.progress_interval < 5):
        parser.error("--progress-interval requires archive polling and a minimum of 5 seconds")
    if args.status_port is not None and (not args.interval or not 1024 <= args.status_port <= 65535):
        parser.error("--status-port requires polling and a port from 1024 to 65535")
    if args.interval and args.interval < 30:
        parser.error("--interval must be zero or at least 30 seconds")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        config = json.loads(args.connection_file.read_text()) if args.connection_file else os.environ
        client = Suwayomi(config)
        args.output.mkdir(parents=True, exist_ok=True)
        with (args.output / ".suwayomi-volume.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for stale in args.output.glob(".suwayomi-*.tmp"):
                stale.unlink()
            archive_errors = {}
            history = DownloadHistory(args.output)
            if args.status_port:
                start_status_server(client, args.output, args.status_port, args.settings_file, archive_errors, history)
            if args.progress_interval:
                Thread(target=log_download_progress, args=(client, args.progress_interval), daemon=True).start()
            logging.info("Suwayomi chapter exporter started (interval: %ds)", args.interval)
            while True:
                try:
                    current, previous = storage_roots(args.output, args.settings_file)
                    failures = run_once(client, current, previous, archive_errors, history)
                except (ArchiveError, OSError, ValueError, TypeError, KeyError, sqlite3.Error) as exc:
                    logging.error("export scan failed: %s", exc)
                    failures = 1
                if not args.interval:
                    return int(bool(failures))
                time.sleep(args.interval)
    except (ArchiveError, OSError, ValueError, sqlite3.Error) as exc:
        logging.error("cannot start chapter exporter: %s", exc)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

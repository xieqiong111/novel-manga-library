from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

from archive import (
    ArchiveError, Suwayomi, archive_catalog, archive_directories, run_once,
    series_directory, standalone_chapters, storage_roots, write_cbz,
)


def chapter(chapter_id, name, downloaded=True, page_count=3):
    return {"id": chapter_id, "name": name, "isDownloaded": downloaded, "pageCount": page_count}


class FakeSuwayomi:
    def __init__(self):
        self.calls = []

    def chapter_zip(self, chapter_id, output):
        self.calls.append(chapter_id)
        with ZipFile(output, "w") as archive:
            for index in [10, 2, 1]:
                archive.writestr(f"pages/{index}.jpg", bytes([chapter_id, index]))
            archive.writestr("ComicInfo.xml", "<ComicInfo/>")
        output.seek(0)


def old_volume(client, root, manga, volume, chapters, previous=()):
    title = f"第{volume:02}卷"
    return write_cbz(client, root, manga, title + ".cbz", title, str(volume), chapters,
                     archive_directories(root, previous, manga))


class ChapterArchiveTests(unittest.TestCase):
    def test_chapter_selection_ignores_whole_volumes_and_accepts_mixed_labels(self):
        whole = chapter(5, "第１２卷")
        standalone = chapter(6, "第12话")
        prefixed = chapter(8, "Vol. 8 - Chapter 14.5")
        named = chapter(9, "序章")
        self.assertEqual(list(standalone_chapters([whole, standalone, prefixed, named])), [
            ("12", standalone), ("14.5", prefixed), (None, named),
        ])

    def test_export_orders_pages_and_separates_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            client = FakeSuwayomi()
            a = {"id": 17, "sourceId": "99", "title": "試/作"}
            b = {"id": 18, "sourceId": "100", "title": "試/作"}
            chapters = [chapter(3, "第2卷 第2话"), chapter(4, "第2卷 第3话")]
            self.assertTrue(old_volume(client, root, a, 2, chapters))
            self.assertFalse(old_volume(client, root, {**a, "title": "別名"}, 2, chapters))
            self.assertTrue(old_volume(client, root, b, 2, chapters))
            self.assertEqual(client.calls, [3, 4, 3, 4])
            self.assertEqual(len(list(root.glob("*/*.cbz"))), 2)
            self.assertTrue((root / "試_作 [100-18]" / "第02卷.cbz").is_file())
            with ZipFile(root / "試_作" / "第02卷.cbz") as archive:
                self.assertIsNone(archive.testzip())
                self.assertEqual([archive.read(f"{i:06}.jpg") for i in range(1, 7)],
                                 [bytes([ch, i]) for ch in (3, 4) for i in (1, 2, 10)])
                xml = ElementTree.fromstring(archive.read("ComicInfo.xml"))
                self.assertEqual(xml.findtext("Number"), "2")
                self.assertEqual(xml.findtext("PageCount"), "6")

    def test_chapters_export_directly_to_the_selected_folder_with_stable_names(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            selected = root / "用户选择"
            selected.mkdir()
            client = FakeSuwayomi()
            manga = {"id": 3482, "sourceId": "99", "title": "无职转生"}
            rows = [
                chapter(5, "1 难不成是：异世界"),
                chapter(6, "第１.５話 幕间"),
                chapter(7, "第１.５話 幕间（另一版本）"),
                chapter(8, "第2话", downloaded=False),
                chapter(9, "序章"),
            ]
            with patch.object(client, "downloaded_mangas", return_value={3482: manga}, create=True), patch.object(
                client, "manga_chapters", return_value=rows, create=True
            ):
                self.assertEqual(run_once(client, selected), 0)
                self.assertEqual(run_once(client, selected), 0)
            series = selected / "无职转生"
            self.assertEqual(sorted(file.name for file in series.glob("*.cbz")), [
                "章节 [9].cbz", "第001.5话 [6].cbz", "第001.5话 [7].cbz", "第001话 [5].cbz",
            ])
            self.assertEqual(client.calls, [5, 6, 7, 9])
            with ZipFile(series / "第001.5话 [6].cbz") as archive:
                self.assertIsNone(archive.testzip())
                info = ElementTree.fromstring(archive.read("ComicInfo.xml"))
                self.assertEqual(info.findtext("Series"), "无职转生")
                self.assertEqual(info.findtext("Title"), "第１.５話 幕间")
                self.assertEqual(info.findtext("Number"), "1.5")
            self.assertEqual(series_directory(selected, {**manga, "title": "新名字"}), series)

    def test_chapter_catalog_filters_ids_and_reports_export_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manga = {"id": 1, "sourceId": "4", "title": "樣本"}
            chapters = [chapter(5, "1 开始"), chapter(6, "2 等待", downloaded=False), chapter(7, "3 归档失败", page_count=4)]
            client = FakeSuwayomi()
            errors = {}
            with patch.object(client, "manga", return_value=manga, create=True), patch.object(
                client, "downloaded_mangas", return_value={1: manga}, create=True
            ), patch.object(client, "manga_chapters", return_value=chapters, create=True), self.assertLogs(level="ERROR"):
                self.assertEqual(run_once(client, root, archive_errors=errors), 1)
                catalog = archive_catalog(client, root, 1, chapter_ids={"5", "7"}, archive_errors=errors)
                page = archive_catalog(client, root, 1, limit=1, offset=1)
            self.assertEqual(catalog["archiveMode"], "chapter")
            self.assertEqual(catalog["chapterCount"], 3)
            self.assertEqual(catalog["chapters"][0]["filename"], "第001话 [5].cbz")
            self.assertTrue(catalog["chapters"][1]["archiveFailed"])
            self.assertEqual(page["chapters"], [
                {"id": "6", "name": "2 等待", "number": "2", "downloaded": False, "filename": None},
            ])

    def test_legacy_folders_and_existing_unmanaged_series_are_not_mixed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manga = {"id": 17, "sourceId": "99", "title": "試作"}
            unmanaged = root / "試作"
            unmanaged.mkdir()
            (unmanaged / "existing.txt").touch()
            client = FakeSuwayomi()
            chapters = [chapter(5, "第1卷"), chapter(6, "第1话")]
            with patch.object(client, "downloaded_mangas", return_value={17: manga}, create=True), patch.object(
                client, "manga_chapters", return_value=chapters, create=True
            ):
                self.assertEqual(run_once(client, root), 0)
            self.assertEqual(client.calls, [6])
            self.assertEqual([file.name for file in unmanaged.iterdir()], ["existing.txt"])
            legacy = root / "試作 [99-17]"
            self.assertTrue((legacy / "第001话 [6].cbz").is_file())
            self.assertEqual(series_directory(root, {**manga, "title": "別名"}), legacy)

    def test_chapter_export_does_not_wait_for_other_chapters_or_duplicate_legacy_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            client = FakeSuwayomi()
            manga = {"id": 1, "sourceId": "2", "title": "樣本"}
            old = chapter(10, "第2卷 第4话")
            pending = chapter(11, "第2卷 第5话", downloaded=False)
            ready = chapter(12, "第2卷 第6话")
            whole = chapter(13, "第2卷")
            rows = [old, pending, ready, whole]
            old_volume(client, root, manga, 2, [old])
            with patch.object(client, "manga", return_value=manga, create=True), patch.object(
                client, "manga_chapters", return_value=rows, create=True
            ), patch.object(client, "downloaded_mangas", return_value={1: manga}, create=True):
                self.assertEqual(run_once(client, root), 0)
                self.assertEqual(run_once(client, root), 0)
                catalog = archive_catalog(client, root, 1)
            self.assertEqual(client.calls, [10, 12])
            self.assertEqual(catalog["volumes"], [])
            self.assertEqual(catalog["archiveMode"], "chapter")
            self.assertEqual([(entry["id"], entry["filename"], entry.get("legacyVolume")) for entry in catalog["chapters"]], [
                ("10", None, "第02卷.cbz"),
                ("11", None, None),
                ("12", "第006话 [12].cbz", None),
            ])
            self.assertEqual(sorted(p.name for p in (root / "樣本").glob("*.cbz")), ["第006话 [12].cbz", "第02卷.cbz"])

    def test_download_status_uses_upstream_numbers_and_keeps_unknown_progress(self):
        client = Suwayomi({"SUWAYOMI_URL": "http://suwayomi:4567"})
        with patch.object(client, "graphql", return_value={"downloadStatus": {"state": "STARTED", "queue": [
            {"state": "DOWNLOADING", "progress": 0.38, "chapter": {"id": 31, "mangaId": 22, "name": "第2卷"}},
            {"state": "QUEUED", "progress": None, "chapter": {"id": 32, "mangaId": 22, "name": "第3卷"}},
        ]}}):
            result = client.download_status()
        self.assertEqual(result["queue"][0]["percent"], 38)
        self.assertIsNone(result["queue"][1]["percent"])

    def test_changing_storage_keeps_previous_volume_and_redirects_new_one(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            settings = root / "download-folders.json"
            (root / "新目录").mkdir()
            client = FakeSuwayomi()
            manga = {"id": 1, "sourceId": "2", "title": "樣本"}
            one = chapter(10, "第1卷")
            two = chapter(11, "第2卷")
            old_volume(client, root, manga, 1, [one])
            settings.write_text('{"mangaFolder":"新目录","mangaPrevious":[""]}')
            current, previous = storage_roots(root, settings)
            self.assertFalse(old_volume(client, current, manga, 1, [one], previous))
            self.assertTrue(old_volume(client, current, manga, 2, [two], previous))
            self.assertEqual(len(list(root.glob("*/*.cbz"))), 1)
            self.assertEqual(len(list(current.glob("*/*.cbz"))), 1)
            (root / "link").symlink_to(current, target_is_directory=True)
            settings.write_text('{"mangaFolder":"link","mangaPrevious":[]}')
            with self.assertRaises(ArchiveError):
                storage_roots(root, settings)

    def test_failed_refresh_preserves_existing_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            client = FakeSuwayomi()
            manga = {"id": 1, "sourceId": "2", "title": "樣本"}
            old = chapter(10, "第1卷 第1话")
            old_volume(client, root, manga, 1, [old])
            artifact = next(root.glob("*/*.cbz"))
            original = artifact.read_bytes()
            bad = chapter(11, "第1卷 第2话", page_count=4)
            with self.assertRaisesRegex(ArchiveError, "expected 4"):
                old_volume(client, root, manga, 1, [old, bad])
            self.assertEqual(artifact.read_bytes(), original)
            self.assertEqual(list(root.glob(".suwayomi-*")), [])

    def test_truncated_zip_leaves_no_library_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            client = FakeSuwayomi()
            manga = {"id": 1, "sourceId": "2", "title": "樣本"}
            def corrupt(_id, output):
                output.write(b"not-a-cbz")
                output.seek(0)
            with patch.object(client, "chapter_zip", corrupt):
                with self.assertRaises(BadZipFile):
                    old_volume(client, root, manga, 1, [chapter(7, "第1卷")])
            self.assertEqual(list(root.iterdir()), [])


if __name__ == "__main__":
    unittest.main()

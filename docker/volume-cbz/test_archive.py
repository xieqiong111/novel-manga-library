import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

from archive import (
    ArchiveError, BangumiFolderConflict, DownloadHistory, Suwayomi, archive_catalog, archive_directories, run_once,
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
    def test_complete_volume_uses_catalog_order_and_actual_zero_based_bookmarks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            settings = root / "config" / "download-folders.json"
            catalogs = settings.parent / "manga-volume-catalogs"
            catalogs.mkdir(parents=True)
            settings.write_text(json.dumps({"mangaArchive": {"enabled": True}}))
            manga = {"id": 17, "sourceId": "99", "title": "正式名称", "realUrl": "https://example.org/manga/17",
                     "bangumi": {"subjectId": 123, "title": "正式名称"}}
            (catalogs / "17.json").write_text(json.dumps({
                "workUrl": manga["realUrl"], "mangaId": "17", "sourceId": "99", "subjectId": 123,
                "volumes": [{"number": 1, "chapters": ["2", "1"], "source": "publisher", "confirmed": True},
                            {"number": 2, "chapters": ["3", "4"], "source": "publisher", "confirmed": True}],
                "volumeMetadata": [{"number": 1, "subjectId": 124}],
            }))
            rows = [chapter(3, "第1话·开端", page_count=1), chapter(4, "第2话·番外 & 序", False, page_count=2),
                    chapter(5, "第3话"), chapter(6, "第4话", False)]
            client = FakeSuwayomi()
            client.manga = lambda _: manga
            client.downloaded_mangas = lambda: {17: manga}
            client.manga_chapters = lambda _: rows

            def download(chapter_id, output):
                client.calls.append(chapter_id)
                row = next(row for row in rows if row["id"] == chapter_id)
                with ZipFile(output, "w") as source:
                    for page in reversed(range(row["pageCount"])):
                        source.writestr(f"{page}.jpg", bytes([chapter_id, page]))
                output.seek(0)

            client.chapter_zip = download
            history = DownloadHistory(root)
            first = root / "正式名称" / "第01卷"
            volume = first / "第01卷.cbz"
            self.assertEqual(run_once(client, root, history=history, settings=settings), 0)
            self.assertTrue((first / "第001话 [3].cbz").is_file())
            self.assertFalse(volume.exists())
            rows[1]["isDownloaded"] = True
            for _ in range(2):
                self.assertEqual(run_once(client, root, history=history, settings=settings), 0)
            self.assertEqual(client.calls, [3, 5, 4])
            self.assertEqual(list(first.glob("*.cbz")), [volume])
            self.assertTrue((first / ".studio-chapters" / "第001话 [3].cbz").is_file())
            self.assertTrue((first.parent / "第02卷" / "第003话 [5].cbz").is_file())
            with ZipFile(volume) as archive:
                self.assertIsNone(archive.testzip())
                info = ElementTree.fromstring(archive.read("ComicInfo.xml"))
                self.assertEqual(info.findtext("Web"), "https://bgm.tv/subject/124")
                self.assertEqual(info.findtext("PageCount"), "3")
                self.assertEqual([(mark.attrib, archive.read(f"{int(mark.get('Image')) + 1:06}.jpg"))
                                  for mark in info.findall("./Pages/Page")], [
                    ({"Image": "0", "Bookmark": "第2话·番外 & 序"}, bytes([4, 0])),
                    ({"Image": "2", "Bookmark": "第1话·开端"}, bytes([3, 0])),
                ])
            catalog = archive_catalog(client, root, 17, storage_root=root, settings=settings)
            relative = volume.relative_to(root).as_posix()
            self.assertEqual([(row["relativeFile"], row["packedVolume"]) for row in catalog["chapters"][:2]],
                             [(relative, True), (relative, True)])
            self.assertEqual([event["file"] for event in history.events(0)["events"]].count(relative), 1)
            self.assertEqual([entry["file"] for entry in history.page(None, 20, None)["history"]].count(relative), 2)

    def test_bangumi_binding_names_only_new_chapters_and_protects_other_editions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            settings = root / "settings" / "download-folders.json"
            bindings = settings.parent / "bangumi-manga"
            bindings.mkdir(parents=True)
            manga = {"id": 17, "sourceId": "99", "title": "下载源别名"}
            (bindings / "17.json").write_text(json.dumps({
                "mangaId": "17", "sourceId": "99", "subjectId": 123, "title": "正式名称 ～副标题～",
            }), encoding="utf-8")
            live = Suwayomi({"SUWAYOMI_URL": "http://example.invalid"}, settings)
            client = FakeSuwayomi()
            first, second = chapter(3, "第1话"), chapter(4, "第2话")
            write_cbz(client, root, manga, "第001话 [3].cbz", first["name"], "1", [first],
                      archive_directories(root, [], manga))
            with patch.object(live, "manga", return_value=manga), patch.object(
                live, "downloaded_mangas", return_value={17: manga}
            ), patch.object(live, "manga_chapters", return_value=[first, second]), patch.object(
                live, "chapter_zip", side_effect=client.chapter_zip
            ):
                self.assertEqual(run_once(live, root), 0)
                catalog = archive_catalog(live, root, 17, storage_root=root)
            self.assertEqual(catalog["bangumiSubjectId"], 123)
            self.assertEqual([row["relativeFile"] for row in catalog["chapters"]], [
                "下载源别名/第001话 [3].cbz", "正式名称 ～副标题～/第002话 [4].cbz",
            ])
            self.assertEqual(client.calls, [3, 4])
            self.assertTrue((root / "下载源别名" / "第001话 [3].cbz").is_file())
            with ZipFile(root / "正式名称 ～副标题～" / "第002话 [4].cbz") as archive:
                info = ElementTree.fromstring(archive.read("ComicInfo.xml"))
                self.assertEqual(info.findtext("Series"), "正式名称 ～副标题～")
                self.assertEqual(info.findtext("Web"), "https://bgm.tv/subject/123")
            with self.assertRaises(BangumiFolderConflict):
                archive_directories(root, [], {**live.archive_identity(manga), "id": 18})

    def test_single_work_graphql_selection_includes_canonical_source_url(self):
        client = Suwayomi({"SUWAYOMI_URL": "http://example.invalid"})
        result = {"id": 17, "realUrl": "https://example.invalid/manga/17"}
        with patch.object(client, "graphql", return_value={"manga": result}) as graphql:
            self.assertEqual(client.manga(17), result)
        self.assertIn("sourceId url realUrl", graphql.call_args.args[0])
        self.assertEqual(graphql.call_args.kwargs, {"id": 17})

    def test_volume_layout_uses_verified_version_and_keeps_one_cbz_per_chapter(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            settings = root / "config" / "download-folders.json"
            bindings = settings.parent / "bangumi-manga"
            bindings.mkdir(parents=True)
            catalogs = settings.parent / "manga-volume-catalogs"
            catalogs.mkdir()
            manga = {"id": 17, "sourceId": "99", "title": "下载源别名",
                     "url": "manga/main", "realUrl": "https://example.org/manga/main"}
            binding = {"mangaId": "17", "sourceId": "99", "subjectId": 123, "title": "正式中文名称"}
            (bindings / "17.json").write_text(json.dumps(binding), encoding="utf-8")
            record = {**binding, "workUrl": manga["realUrl"], "volumes": [
                {"number": 1, "chapters": ["1", "2"], "source": "publisher", "confirmed": True},
                {"number": 2, "chapters": ["3"], "source": "reference", "confirmed": False},
            ], "volumeMetadata": [{"number": 1, "subjectId": 124}]}
            (catalogs / "17.json").write_text(json.dumps(record))
            settings.write_text(json.dumps({"mangaArchive": {"enabled": True, "sources": ["publisher", "reference"]}}))
            live = Suwayomi({"SUWAYOMI_URL": "http://example.invalid"}, settings)
            client = FakeSuwayomi()
            rows = [chapter(3, "第1话"), chapter(4, "第2话-1"), chapter(5, "第3话")]
            history = DownloadHistory(root)
            with patch.object(live, "manga", return_value=manga), patch.object(
                live, "downloaded_mangas", return_value={17: manga}
            ), patch.object(live, "manga_chapters", return_value=rows), patch.object(
                live, "chapter_zip", side_effect=client.chapter_zip
            ):
                self.assertEqual(run_once(live, root, history=history, settings=settings), 0)
                catalog = archive_catalog(live, root, 17, storage_root=root, settings=settings)
                saved = [row["relativeFile"] for row in catalog["chapters"]]
                self.assertEqual(saved, [
                    "正式中文名称/第01卷/第001话 [3].cbz",
                    "正式中文名称/未分卷/第002话 [4].cbz",
                    "正式中文名称/未分卷/第003话 [5].cbz",
                ])
                with ZipFile(root / saved[0]) as archive:
                    info = ElementTree.fromstring(archive.read("ComicInfo.xml"))
                    self.assertEqual(info.findtext("Number"), "1")
                    self.assertEqual(info.findtext("Volume"), "1")
                    self.assertEqual(info.findtext("Web"), "https://bgm.tv/subject/124")
                    self.assertEqual(len(archive.namelist()), 4)
                settings.write_text(json.dumps({"mangaArchive": {"enabled": False, "sources": []}}))
                self.assertEqual(run_once(live, root, history=history, settings=settings), 0)
                self.assertEqual(client.calls, [3, 4, 5])
                self.assertEqual(len(history.events(0)["events"]), 3)

    def test_preserves_legacy_history_for_a_whole_volume_in_a_volume_subfolder(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            client = FakeSuwayomi()
            manga = {"id": 17, "sourceId": "99", "title": "作品"}
            row = chapter(3, "第1卷")
            self.assertTrue(old_volume(client, root, manga, 1, [row]))
            section = root / "作品" / "第01卷"
            section.mkdir()
            (section.parent / "第01卷.cbz").rename(section / "第01卷.cbz")
            history = DownloadHistory(root)
            with patch.object(client, "downloaded_mangas", return_value={17: manga}, create=True), patch.object(
                client, "manga_chapters", return_value=[row], create=True
            ):
                self.assertEqual(run_once(client, root, history=history), 0)
            saved = history.page(None, 10, "17")["history"][0]
            self.assertEqual(saved["archiveState"], "legacy")
            self.assertEqual(saved["file"], "作品/第01卷/第01卷.cbz")
            self.assertEqual(client.calls, [3])

    def test_completed_history_survives_restart_and_emits_only_new_exports(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manga = {"id": 17, "sourceId": "99", "title": "样本"}
            first, second = chapter(3, "第1话"), chapter(4, "第2话")
            client = FakeSuwayomi()
            # Confirm an existing CBZ first to exercise import without a follow-up event.
            write_cbz(client, root, manga, "第001话 [3].cbz", first["name"], "1", [first],
                      archive_directories(root, [], manga))
            history = DownloadHistory(root)
            with patch.object(client, "downloaded_mangas", return_value={17: manga}, create=True), patch.object(
                client, "manga_chapters", return_value=[first, second], create=True
            ):
                self.assertEqual(run_once(client, root, history=history), 0)
                self.assertEqual(run_once(client, root, history=history), 0)
            reopened = DownloadHistory(root)
            page = reopened.page(None, 1, "17")
            self.assertEqual([row["chapterId"] for row in page["history"]], ["4"])
            earlier = reopened.page(page["nextBefore"], 1, "17")
            self.assertEqual([row["chapterId"] for row in earlier["history"]], ["3"])
            self.assertEqual(reopened.events(0), {"events": [
                {"seq": 1, "mangaId": "17", "file": "样本/第002话 [4].cbz"},
            ]})

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

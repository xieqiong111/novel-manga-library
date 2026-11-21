"""Run BangumiKomga metadata conversion for the Studio backend over stdio."""

import json
import os
import string
import sys
import time
from pathlib import Path

# Keep the upstream log handler off the JSON response stream.
reply_stream = sys.stdout
if __name__ == "__main__":
    sys.stdout = sys.stderr

import requests
from pypinyin import Style, slug
from zhconv import convert

from api.bangumi_api import BangumiArchiveDataSource
from api.bangumi_model import SubjectPlatform
from bangumi_archive.local_archive_searcher import parse_infobox
from core.process_metadata import set_komga_book_metadata, set_komga_series_metadata
from corpus.vocabulary import ALL_PUBLISHERS
from tools.resort_search_results_list import compute_name_score_by_fuzzy

PLATFORMS = {"novel": SubjectPlatform.Novel, "manga": SubjectPlatform.Comic}
MAX_RESPONSE = 2 * 1024 * 1024
USER_AGENT = "NovelAndMangaStudio/1.0 (https://github.com/xieqiong111/novel-manga-library)"


class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code


class Bangumi:
    provenance = {"source": "bangumi-live"}

    def __init__(self, access_token=""):
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
        token = access_token.strip()
        if token:
            self.session.headers["Authorization"] = f"Bearer {token}"
        self.next_request = 0

    def request(self, path, body=None):
        time.sleep(max(0, self.next_request - time.monotonic()))
        self.next_request = time.monotonic() + 0.5
        with self.session.request(
            "GET" if body is None else "POST", "https://api.bgm.tv" + path,
            json=body, timeout=(3, 5), allow_redirects=False, stream=True,
        ) as response:
            status = response.status_code
            if status == 404:
                raise ApiError(404, "BANGUMI_NOT_FOUND", "Bangumi 条目不存在或不可读取。")
            if status in (401, 403):
                raise ApiError(502, "BANGUMI_AUTH_FAILED", "Bangumi 拒绝访问，请检查服务端令牌。")
            if status == 429:
                raise ApiError(429, "BANGUMI_RATE_LIMIT", "Bangumi 请求过于频繁，请稍后重试。")
            if status != 200:
                raise ApiError(502, "BANGUMI_HTTP_ERROR", f"Bangumi 返回 HTTP {status}。")
            data = bytearray()
            for chunk in response.iter_content(chunk_size=16384):
                data.extend(chunk)
                if len(data) > MAX_RESPONSE:
                    raise ApiError(502, "BANGUMI_RESPONSE_TOO_LARGE", "Bangumi 响应超出大小限制。")
            return json.loads(data)

    def search_candidates(self, query):
        return self.request("/v0/search/subjects?limit=20", {
            "keyword": query, "filter": {"type": [1]},
        })["data"]

    def get_subject_metadata(self, subject_id):
        return self.request(f"/v0/subjects/{subject_id}")

    def get_related_subjects(self, subject_id):
        return self.request(f"/v0/subjects/{subject_id}/subjects")


class Archive(BangumiArchiveDataSource):
    def __init__(self, directory):
        super().__init__(str(Path(directory).resolve()) + os.sep)
        stamp = Path(directory) / "archive_update_time.json"
        self.provenance = {"source": "bangumi-archive"}
        if stamp.is_file():
            self.provenance["archiveVersion"] = json.loads(stamp.read_text()).get("last_updated")

    def search_candidates(self, query):
        candidates = self._get_search_results_from_archive(query)
        return [
            {**item, "infobox": parse_infobox(item.get("infobox") or "")}
            for item in candidates if not item.get("nsfw")
        ]

    def get_subject_metadata(self, subject_id):
        subject = super().get_subject_metadata(subject_id)
        if not subject or subject.get("nsfw"):
            raise ApiError(404, "BANGUMI_NOT_FOUND", "公开档案中没有该条目。")
        return subject


def matches(subject, kind, scope):
    return (
        subject["type"] == 1
        and SubjectPlatform.parse(subject["platform"]) == PLATFORMS[kind]
        and subject.get("series") is (scope == "series")
    )


def candidate(subject):
    return {
        "id": subject["id"], "name": subject["name"], "nameCn": subject.get("name_cn") or "",
        "date": subject.get("date"), "summary": (subject.get("summary") or "")[:500],
    }


def search(bangumi, query, kind, scope):
    normalized = convert(query, "zh-cn")
    found = []
    for subject in bangumi.search_candidates(normalized):
        if matches(subject, kind, scope):
            row = candidate(subject)
            row["score"] = compute_name_score_by_fuzzy(
                convert(row["name"], "zh-cn"), convert(row["nameCn"], "zh-cn"),
                subject.get("infobox") or [], normalized,
            )
            found.append(row)
    return {"candidates": sorted(found, key=lambda row: row["score"], reverse=True)[:10], **bangumi.provenance}


def metadata(bangumi, subject_id, kind, scope, options):
    subject = bangumi.get_subject_metadata(subject_id)
    if subject.get("id") != subject_id or not matches(subject, kind, scope):
        raise ApiError(422, "BANGUMI_TYPE_MISMATCH", "Bangumi 条目与选择的类型或系列／单册范围不符。")
    for field, default in (("infobox", []), ("tags", []), ("rating", {"score": 0})):
        if subject.get(field) is None:
            subject[field] = default
    if scope == "series":
        converted = set_komga_series_metadata(subject, "", bangumi)
        names = ("title", "summary", "publisher", "alternateTitles", "tags", "links", "ageRating")
    else:
        # Conversion requests this same subject again. Reuse the validated response.
        class BookSource:
            def get_subject_metadata(self, _subject_id):
                return subject

            def get_related_subjects(self, requested_id):
                return bangumi.get_related_subjects(requested_id)

        converted = set_komga_book_metadata(subject_id, 0, "", BookSource())
        names = ("summary", "authors", "releaseDate", "tags", "links")
    patch = {name: getattr(converted, name) for name in names}
    if scope == "series":
        local_name = options.get("localName") or ""
        title = patch["title"] or ""
        if options.get("sortTitle") and local_name and title and local_name[0] not in string.ascii_letters:
            initial = title[0] if title[0] in string.ascii_letters else slug(
                title[0], style=Style.FIRST_LETTER, separator="", errors="ignore",
            )
            if initial:
                patch["titleSort"] = initial.upper() + local_name
        if options.get("addLocalVersion"):
            publisher = next((name for name in ALL_PUBLISHERS if name in local_name), None)
            if publisher:
                patch["localVersion"] = publisher
    result = {"subject": candidate(subject), "metadata": patch, **bangumi.provenance}
    if result["source"] == "bangumi-live" and options.get("includeCover"):
        images = subject.get("images") or {}
        result["coverUrl"] = images.get("large") or images.get("common")
    return result


def configured_source(mode, token):
    if mode == "archive":
        directory = os.environ.get("BANGUMI_ARCHIVE_DIR")
        if not directory or not all((Path(directory) / file).is_file() for file in
                                    ("subject.jsonlines", "subject-relations.jsonlines")):
            raise ApiError(503, "BANGUMI_ARCHIVE_UNAVAILABLE", "尚未挂载 Bangumi 官方档案。")
        return Archive(directory)
    return Bangumi(token)


def dispatch(bangumi, operation, params):
    kind = params.get("kind")
    scope = params.get("scope")
    if kind not in PLATFORMS or scope not in ("series", "book"):
        raise ApiError(400, "INVALID_METADATA_TYPE", "请选择小说或漫画，以及系列或单册。")
    if operation == "search":
        query = params.get("query", "").strip()
        if not 1 <= len(query) <= 200:
            raise ApiError(400, "INVALID_QUERY", "请输入 1 至 200 个字符。")
        return search(bangumi, query, kind, scope)
    if operation == "metadata":
        subject_id = params.get("subjectId")
        if type(subject_id) is not int or not 1 <= subject_id <= 9999999999:
            raise ApiError(400, "INVALID_SUBJECT_ID", "请填写有效的 Bangumi 条目 ID。")
        return metadata(bangumi, subject_id, kind, scope, params)
    raise ApiError(404, "NOT_FOUND", "未知操作。")


def serve():
    bangumi = None
    current = None
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request["id"]
            config = request.get("bangumi", {})
            mode = config.get("sourceMode") or ("archive" if os.environ.get("BANGUMI_ARCHIVE_DIR") else "live")
            token = config.get("accessToken", "") if mode == "live" else ""
            if (mode, token) != current:
                bangumi = configured_source(mode, token)
                current = (mode, token)
            payload = dispatch(bangumi, request["operation"], request["params"])
            status = 200
        except ApiError as error:
            status, payload = error.status, {"error": {"code": error.code, "message": str(error)}}
        except requests.Timeout:
            status, payload = 504, {"error": {"code": "BANGUMI_TIMEOUT", "message": "Bangumi 响应超时。"}}
        except (requests.RequestException, ValueError, KeyError, TypeError, AttributeError):
            status, payload = 502, {"error": {"code": "BANGUMI_ERROR", "message": "Bangumi 不可用或返回了无法转换的数据。"}}
        print(json.dumps({"id": request_id, "status": status, "payload": payload}, ensure_ascii=False),
              file=reply_stream, flush=True)


if __name__ == "__main__":
    serve()

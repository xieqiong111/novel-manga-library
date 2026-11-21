ARG STUDIO_WEB_BASE=node:24-bookworm-slim
ARG STUDIO_PYTHON_BASE=python:3.12-slim-bookworm

FROM ${STUDIO_PYTHON_BASE} AS bangumi
ARG BANGUMIKOMGA_REV=3ce5304707e4b8860b48d701b03f89bf421bac7e
WORKDIR /opt/studio-bangumikomga
ADD https://codeload.github.com/chu-shen/BangumiKomga/tar.gz/${BANGUMIKOMGA_REV} /tmp/bangumi-upstream.tar.gz
RUN tar -xzf /tmp/bangumi-upstream.tar.gz --strip-components=1 \
    && rm /tmp/bangumi-upstream.tar.gz \
    && pip install --no-cache-dir -r install/requirements.txt \
    && mkdir -p /opt/studio-python-libs \
    && find /usr/local/lib/python3.12/lib-dynload -name '*.so' -exec ldd {} + \
      | awk '/=> \// && $1 !~ /^(libc|libm|libdl|libpthread|librt|libutil)\.so/ { print $3 }' \
      | sort -u | xargs -r -I '{}' cp -L '{}' /opt/studio-python-libs/
COPY --chmod=0644 config.py config/config.py
COPY --chmod=0644 studio.py .

FROM ${STUDIO_WEB_BASE}
COPY --from=bangumi /usr/local/bin/python3.12 /usr/local/bin/python3.12
COPY --from=bangumi /usr/local/lib/libpython3.12.so.1.0 /usr/local/lib/libpython3.12.so.1.0
COPY --from=bangumi /usr/local/lib/python3.12 /usr/local/lib/python3.12
COPY --from=bangumi /opt/studio-python-libs /opt/studio-python-libs
COPY --from=bangumi /opt/studio-bangumikomga /opt/studio-bangumikomga
ENV LN_BANGUMIKOMGA_SCRIPT=/opt/studio-bangumikomga/studio.py \
    LN_BANGUMIKOMGA_PYTHON=/usr/local/bin/python3.12 \
    LN_BANGUMIKOMGA_LIBRARY_PATH=/opt/studio-python-libs:/usr/local/lib

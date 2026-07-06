#!/usr/bin/env bash
# EmDash Worker(生成元)をクロールして静的サイトを生成する。
# 出力は dist-static/ 。デプロイは `pnpm deploy:static`。
#
# 使い方:
#   ORIGIN=https://admin.blog.ochanu.co bash scripts/generate-static.sh
set -euo pipefail

ORIGIN="${ORIGIN:-https://admin.blog.ochanu.co}"
PUBLIC_HOST="${PUBLIC_HOST:-blog.ochanu.co}"
OUT="${OUT:-dist-static}"

ADMIN_HOST="${ORIGIN#https://}"
ADMIN_HOST="${ADMIN_HOST#http://}"

command -v wget >/dev/null || {
	echo "error: wget が必要です (macOS: brew install wget)" >&2
	exit 1
}

rm -rf "$OUT"
mkdir -p "$OUT"

echo "==> クロール: $ORIGIN"
# --adjust-extension: /posts/xxx を posts/xxx.html として保存
#   (Workers Static Assets の auto-trailing-slash 解決に合わせる)
# 管理画面と認証・検索 API は除外
wget \
	--mirror \
	--page-requisites \
	--no-parent \
	--adjust-extension \
	--no-host-directories \
	--restrict-file-names=nocontrol \
	-e robots=off \
	--reject-regex '/_emdash/(admin|api/(auth|search))' \
	--directory-prefix="$OUT" \
	"$ORIGIN/" || {
	# exit 8 = 一部 URL が 404 等。リンク切れは致命でないため続行
	code=$?
	[ "$code" -eq 8 ] || exit "$code"
	echo "warn: 一部の URL の取得に失敗しました (exit 8)" >&2
}

echo "==> リンクされないエンドポイントを取得"
# search はヘッダーの form action のためミラーでは辿られない
for path in search rss.xml sitemap.xml sitemap-posts.xml robots.txt; do
	[ -f "$OUT/$path" ] || [ -f "$OUT/$path.html" ] && continue # 取得済みならスキップ
	wget -q --adjust-extension --directory-prefix="$OUT" "$ORIGIN/$path" ||
		echo "skip: /$path" >&2
done

echo "==> 404 ページを取得"
curl -sf --output /dev/null "$ORIGIN/__not_found__" && {
	echo "error: 存在しないはずの URL が 200 を返しました" >&2
	exit 1
} || true
curl -s "$ORIGIN/__not_found__" -o "$OUT/404.html"

echo "==> ホスト名を書き換え: $ADMIN_HOST -> $PUBLIC_HOST"
find "$OUT" \( -name '*.html' -o -name '*.xml' -o -name '*.txt' \) -print0 |
	xargs -0 sed -i.orig \
		-e "s|${ADMIN_HOST}|${PUBLIC_HOST}|g" \
		-e "s|http://${PUBLIC_HOST}|https://${PUBLIC_HOST}|g"
find "$OUT" -name '*.orig' -delete

# EmDash のサイト URL 設定が apex (ochanu.co) を指しているため、
# sitemap / robots に限り公開ホストへ補正する(記事本文中の apex への
# 正当なリンクを壊さないよう対象ファイルを絞る)。
# 管理画面のサイト URL 設定を直せばこの補正は no-op になる。
for f in "$OUT"/sitemap*.xml "$OUT"/robots.txt; do
	[ -f "$f" ] || continue
	sed -i.orig "s|https://ochanu\.co/|https://${PUBLIC_HOST}/|g" "$f"
	rm -f "$f.orig"
done

echo "==> Pagefind インデックスを生成"
pnpm exec pagefind --site "$OUT"

echo "==> _headers を生成"
cat >"$OUT/_headers" <<'EOF'
/_astro/*
  Cache-Control: public, max-age=31536000, immutable
/pagefind/*
  Cache-Control: public, max-age=3600
/_emdash/api/media/*
  Cache-Control: public, max-age=86400
EOF

echo "==> 完了: $OUT ($(find "$OUT" -type f | wc -l | tr -d ' ') files)"

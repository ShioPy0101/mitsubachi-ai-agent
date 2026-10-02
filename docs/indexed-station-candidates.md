# 駅候補検索の CPU / D1 分担

2026-10-02。実行モードによる data source の切り替えは行わない。

## 調査結果

1. **最大の CPU 負荷候補**: 旧 `StaticRailwayRepository.findCandidatePools` の phonetic 検索。読みごとに全 10,390 駅を走査し、全体と駅名長 ±2 の部分文字列に編集距離を計算していた。全体の類似度は二重に計算され、かなも繰り返し正規化されていた。候補の `slice` は計算後なので CPU 削減にはならない。
2. **旧 D1 の rows read 増加原因**: `1caba09^:src/db/stations-repository.ts` の駅表との結合は `instr(search_text, normalized_name/kana)`、逆向き `instr`、複数 OR を含む。通常の名前・かな B-tree index は、この包含条件の絞り込みに使えない。`ROW_NUMBER` で最終候補数を制限しても、先行する読み取り・順位計算は残る。経路探索でも接続表全件や路線の駅順を読み込んでいた。
3. **static に残す処理**: 名前・多言語表記・隣接駅の直接索引、駅属性、路線の駅順、路線所属、接続グラフ、少数候補の最終スコアリング、経路探索・整合性評価。
4. **D1 に戻す処理**: 読み仮名の曖昧検索に先立つ、文字頻度と読み長による候補 ID の生成のみ。

## 構成と精度

呼び出し側は `StationRepository` を使う。`createRailwayRepository(DB)` が static repository に D1 の `PhoneticCandidateSource` を注入する。public / demo / alpha 等の実行モードは repository の選択に関与しない。ローカルの static 候補源も同じ絞り込み条件を実装する。

D1 の生成表は既存の `stations` ID を参照しない。static master の ID と CSV snapshot hash に対応する独立した postings で、主キーは `(snapshot, token, kana_length, station_id)`。SQL は snapshot と文字の等値条件、かな長の範囲条件で絞り、文字頻度の重なりを集計する。実行計画テストは `SEARCH c USING PRIMARY KEY` と `kana_length<?` を検証し、`SCAN c` を拒否する。候補生成 SQL に順位による LIMIT はない。

類似度 0.6 以上には、比較対象の最大長の 60% 以上の文字頻度の重なりが必要。部分文字列との比較でも、その重なりは読み全体に含まれる。したがって、この必要条件で候補を除外しても、従来の 0.6 以上の結果は失わない。Worker は返却 ID の station を取得し、窓単位の必要条件と従来の編集距離スコアで最終順位を決める。既存の候補数・経路数・精度閾値は下げていない。

経路探索は候補生成・順位付けの後に行う。contained 方式の追加路線仮説も、既存の完全一致駅が所属する路線だけを対象にする。既存の経路長・整合性評価予算に収まらない路線は、曖昧スコアを計算する前に除外する。

ジョブ内で読みの正規化、候補順位、文字列ペアの類似度、路線・グラフ経路をキャッシュする。読みの候補順位は返却 limit に依存しないので、異なる limit でも再利用する。同時 sequence は同じ in-flight Promise を共有する。D1 を使う isolate では、未使用の static 文字 postings を構築しない。

## 処理量のログ

`station_search_work` は下記の phase を出力する。集計結果は job ID を含む既存の `station_correction_summary.metrics.work` にも残す。

| phase                          | 主な指標                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| station candidate generation   | D1 queries / 実際の `meta.rows_read`、返却 ID 数、prefilter / 類似度ペア数、候補順位キャッシュ hit |
| station candidate scoring      | lexical 計算 / cache hit、編集距離呼び出し数・DP セル数、正規化計算 / cache hit、類似度 cache hit  |
| route resolution / path search | alignment 比較数、graph search 回数、graph 展開状態数、路線 pre-ranking の lexical ペア数          |
| sequence reconciliation        | occurrence list 数、実際に確認した候補数、確認した route mention match 数                          |

これらは CPU ミリ秒の推定値ではなく処理量。共有 lookup の前後差を並列 sequence ごとに足し上げると重複計上するため、処理量はジョブの累積 counter を記録する。累積ログ同士を合算しない。lexical / DP counter は経路のスコアリングにも利用する共有計算の総量で、graph 展開や alignment counter とあわせて負荷を判断する。旧 sequence の wall time 指標はそのまま残す。

## ローカル検証

`npm run typecheck`、`npm run test:station`、`npm run test:station:d1`。

追加の Node テスト 6 件と D1 統合テスト 8 件を通過。全件 phonetic 順位との一致、部分文字列スコアの全探索との一致、キャッシュ、binding 数上限に収まらない長い読み、snapshot 不一致、索引の実行計画、駅名補正・複数 sequence・複数路線候補を検証する。D1 / static 候補源で候補 ID・スコア・経路・funnel が一致する。経路検索によって D1 query が増えないことも確認する。

unit suite 全体は 126 件成功、4 件失敗。この 4 件は変更前 HEAD を `/tmp` に展開して同じテストを実行しても再現した。

- `stations-paths.integration`: 名鉄の anchor status と sequence 間 binding の期待値、2 件。
- `static-railway.integration`: 古い D1 snapshot の B 候補集合と名鉄 graph search 回数の期待値、2 件。

期待値を緩めて成功扱いにはしていない。今回の追加検証は独立して成功する。D1 専用テスト設定は Wrangler のインストール済み workerd を使用する。旧 test pool 同梱の workerd はこの環境でクラッシュし、新 runtime と旧 storage snapshot 機能の組み合わせも互換性がないため、この読み取り専用 suite では storage isolation を無効にしている。他の D1 suite の設定は変更しない。

[処理量の比較結果](benchmarks/indexed-station-candidates.json)では、候補順位付けの DP セル数が `やすゆき` で 850,838 → 649、`ちだたけとよ` で 2,212,406 → 8,901。static postings は D1 と同じ候補 ID を返すため、Worker の後段スコアリング処理量を比較できる。D1 実測では `ふせ` は snapshot 確認込みの 2 queries / 357 rows read / 4 ID。これらはローカルの処理量であり、本番 Free 枠での完走を保証する CPU-ms 測定ではない。

## 適用順

新しい Worker をデプロイする前に `0011_indexed_station_candidates.sql` を D1 に適用する。snapshot が欠ける場合は明示的にエラーにし、全駅走査へフォールバックしない。今回、本番 migration / deployment は行っていない。

CSV を更新するときは `npm run generate:railway-data` で static master を更新し、`npm run generate:candidate-index -- data/stations.csv migrations/<新しい番号>.sql` で新 snapshot の候補索引を生成する。既存 migration を上書きして再適用しない。生成 SQL は `CREATE TABLE IF NOT EXISTS` を使うため、既に索引表がある DB にも新 snapshot の INSERT を新 migration として適用できる。static master と候補索引を同じデータ生成ロジック・CSV から作る。

# 改修・検証報告

## 1. Architecture before / after

対象baseline: `37ef39f`（feat/fast-graph / PR #2）。Beforeはconsumerに音声、AI、D1駅探索、補正、表示、期限、保存を集約。Afterは `src/pipeline/` のtranscription/AI-stage/runner/checkpoint/assembly/deliveryと、`src/stations/` の独立domain/StaticRailwayRepositoryへ分離しました。`consumer.ts` は約1,900行から約400行へ縮小し、Queue validation、job preparation、pipeline invocation、ack/retry、fatal handlingを担当します。

Stage portsにfake providerを注入でき、補正domainはGemini、Discord、Queue、presentation、Cloudflare bindingを知りません。NormalizerはD1を触りません。

## 2. raw / semantic / normalized

RawはCOALESCE checkpoint・clip upsertからの上書き禁止・破棄メソッドの削除で保持します。Semanticはevent kind、source span、segment IDs/time range（対応可能な場合）、language、occurrence、entities、semantic context、equivalent groupを持ちます。音声順のraw spanを保持し、Gemini #1のevent proposalで意味境界を補います。Normalizedはrawと別の派生結果です。

Gemini #2にはraw、Gemini #1 metadata、semantic events、stable mention ID、上位3候補/mention、上位2routeの対応mention部分を渡します。全駅・全route station・debug metricsは渡しません。未確定候補も参考材料で、hard constraintではありません。

## 3. Normalization簡素化

`checkNormalization`、entity hard rejection、route-supported target制約、overall/nonentity similarity、unsupported rewrite、`normalized.includes(mention.text)`を使うreject pipelineを削除しました。旧metadata完全一致helperと未使用factual guard情報も削除しました。JSON shape不正/空出力はraw fallbackと観測になります。数字変更・候補外entity・未知ID・欠落eventは観測のみで、生成文章をrejectしません。

Stable ID/mention roleを使ってdestination/nextStation metadataを同期します。sourceText完全一致は必須ではありません。無関係なentity kindでmetadataを変更しません。モデルがIDを返さない/誤る場合の同期は依然不完全で、観測とfixture評価が必要です。

## 4. Multilingual / long announcements

日本語と英語を別source eventとして保持し、同内容でも削除・融合しません。英語候補は英語表記（例 Wakura Onsen）を用意します。Gemini #2のnormalizedEventsをsource ID/音声順で並べ直し、返らなかったeventだけraw spanを残します。全体をrejectしません。

Sentence境界＋意味event境界が現状のgroupingです。segment対応が可能なら音声時刻も保持します。大規模音声のAPI request分割/batching、実音声反復とWhisper chunk重複の自動判別は残課題です。legacy scalar-only出力やモデルの翻訳誤りまで機械的に保証する設計ではありません。

## 5. Static railway data / source of truth

唯一のsourceは `data/stations.csv`。`generate:railway-data` はstations / line-paths / route-connections / manifestを生成します。駅マスタだけへの単純化はしていません。10,390駅、643 ordered paths、4,574 segment connections。lineとpathを分け、branchをflattenせず、循環のclosing edgeも保持します。IDはsnapshot-localで、versionはCSV SHA-256です。

Module scopeでbyId、normalized name/kana、gram、adjacency、station membership、line/path、segment connection indexを一度構築します。Job-local Promise cacheは同じline/graph requestとpath materializationを共有します。Public/demoとも同じrepositoryを使います。D1版と旧import scriptは削除しました。

## 6. Mechanical correction / evidence品質

Same-line fast path、forward/reverse alignment、限定graph fallback、seed 4 / route 5 / candidate 5の上限、sequence最大3並列、alignment最大100,000 comparisons、route長256の制限、job-local cache、reconciliationを維持しています。長いpathは候補seqのmin/max±6が上限内ならwindowに絞ります。超過時は安全に探索結果を弱め、候補材料自体は残します。

Single occurrenceはroute≥0.85、order=1、矛盾なし、lexical≥0.5、winner margin≥0.18等を要求。Phonetic-onlyはbindしません。Top-5外rescueは強い前後anchor、狭いinterval、ほぼ一意な位置、lexical evidenceを要求します。Route-onlyの候補は観測材料になり得ますが、hard bindはしません。Gemini #2自体は最新方針どおり自由度を持ちます。

Candidate mergeはbound→finalScore→routeScore→lexicalScore等で強い証拠を保持し、同station IDのMap上書き順序に依存しません。

## 7. Funnel / observations

extracted = Gemini #1のmention数、sequenced = role/sequenceに割り当てたdistinct mention、with candidates = 非空pool、route supported = route scoreあり、bound = mechanical bindingあり、corrected = normalized entitiesのstable IDで確認した変更、unresolved = 未変更の非exact mentionです。Correctedの実際の正しさはgold labelで評価します。

Reasonsはno_candidate / no_route_support / low_confidence / ambiguous_candidates / normalization_skipped。Gemini #1の既知駅名mention漏れはstatic longest-match scanでdemo観測のみ。自動追加しません。Injection phrase検出も観測だけです。

## 8. D1 / costs

駅・路線・経路の本番D1 read/writeは削除。Engine実行中はread/writeとも0です。Fresh local D1にmaster tableが存在しない状態でpublic/demoの完全pipelineが完了するtestを通しました。D1はjob、clip、access、callback、monitor、operational checkpointのmutable stateのみです。

Metricsはcandidate returned/surface/phonetic/unique counts、candidate generation、line lookup/route loading、graph、alignment、reconciliation、total、cache hit/miss、graph count、comparisonsです。Warningは時間・comparisons・実rows readで判定し、query数だけに依存しません。Staticのrows readは確実に0です。Operational D1の`rowsReadObserved`はmeta.rows_read取得分のみ（first/batchの一部は集計対象外）で、全D1課金row数として使いません。

## 9. Performance before / after

同一の小型station/path/branch/connection fixtureをlocal workerd D1とstaticで1回ずつ測定。D1削除前の結果は凍結snapshotに保存し、現行staticのcandidates/routesをVitest deep equalityで比較しています。Object property orderのJSON文字列一致とは区別します。全国全ケースの同等性保証ではありません。

| Case | station ms before→after | D1 queries | 実local D1 rows read | graph searches | alignment comparisons | unique candidates |
|---|---|---|---|---|---|---|
| A (3 mentions) | 64 → 2 | 32 → 0 | 275 → 0 | 1 → 1 | 88 → 88 | 4 → 4 |
| B (7 mentions) | 70 → 3 | 33 → 0 | 508 → 0 | 1 → 1 | 0 → 0 | 10 → 10 |
| C (20 mentions) | 74 → 2 | 32 → 0 | 582 → 0 | 1 → 1 | 0 → 0 | 27 → 27 |
| D (3 mentions) | 72 → 1 | 32 → 0 | 241 → 0 | 1 → 1 | 0 → 0 | 4 → 4 |
| E (2 mentions) | 4 → 0 | 2 → 0 | 59 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| F (1 mentions) | 6 → 0 | 3 → 0 | 48 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| G (3 mentions) | 10 → 1 | 5 → 0 | 105 → 0 | 0 → 0 | 12 → 12 | 3 → 3 |
| H (1 mentions) | 9 → 0 | 5 → 0 | 72 → 0 | 0 → 0 | 0 → 0 | 1 → 1 |

この小型fixtureはbranchを含むためCase Aでもgraphに入ります。通常same-lineでgraphに入らないことは別の純粋回帰testで確認しています。上記はquery減少だけでなくwall-clock/実rowsを記録した値です。総audio job時間は実音声/AIがないためbefore/after未測定です。

全国snapshotのNode microbenchmark（7回median、現在コード）のstation phase:

- A-exact: 1.86 ms / station D1 reads=0, writes=0
- B-meitetsu: 13.02 ms / station D1 reads=0, writes=0
- C-long: 21.70 ms / station D1 reads=0, writes=0
- D-transfer: 2.36 ms / station D1 reads=0, writes=0
- E-ambiguous: 1.47 ms / station D1 reads=0, writes=0
- F-multilingual: 2.28 ms / station D1 reads=0, writes=0
- G-injection: 1.38 ms / station D1 reads=0, writes=0
- H-single: 0.21 ms / station D1 reads=0, writes=0
- I-repeated: 2.82 ms / station D1 reads=0, writes=0

JSON parse 43.4ms、index 62.2ms、Node CPU 163.7ms、heap delta 27.9MiB、RSS delta 43.3MiB。TS/module変換時間は除外しています。Node測定は本番Worker CPU/メモリ/cold startではありません。Wrangler起動込みのローカルhealth確認は1799ms。

Job timingはdownload/transcription/semantic/correction/reconciliation/normalization/save/delivery/totalをlogsとdemoへ出します。Station graph全ロードはisolate初期化のみ、jobごとのD1 graphロードはありません。JSONは用途別に生成し、Wrangler bundleはbuild時のJS dataに変換されるためjobごとのJSON parseもありません。

## 10. Timeout / failure / retry

processing_started_at/deadline_at/stage/stage_started_at/failure_codeを追加。started_atは旧transcription開始。deadlineは10–14分のWhisper provider budget＋downstream 6分で16–20分。12分staleで14分Whisperを殺しません。Stale SELECTとUPDATEがactive status/deadline期限を再確認します。160秒・期限前後・14分budget・raceの回帰testあり。

Common runnerは取消確認、AbortSignal、timing、monitor、logging、failure stage taggingを担当。Whisperはabort後もprovider Promiseをawaitし、Promise.raceで放棄しません。Geminiはprovider 60秒（bodyを含む）、stage attempt 90秒、絶対job deadlineを別に扱います。Timeoutログはcreated/processing/stage/deadline/now/elapsed/budgetを含みます。

429/5xx/networkはprovider最大3回、その後Queue最大5 attempt（入力checkpoint再利用）。Invalid schemaはlimited、decode/attachment/job deadline/stage timeoutはnever。正常Whisperの再実行なしはdemo Queue retry integrationで確認。Completion/delivery checkpoint境界のretryを制限しています。

## 11. Prompt injection / presentation

両promptでrawをuntrustedと明示し、JSON structured data boundaryに置きます。Role/JSON/delimiter/日本語命令は音声内容です。Blocklistは防御の中心にせずdiagnosticのみ。Gemini #2出力をhard rejectする安全境界は最新方針で削除済みです。このため実モデルが誘導されない保証はありません。

Publicは「文字起こしを処理しています…」「駅名・経路情報を確認しています…」「内容の解析中にエラーが発生しました。もう一度お試しください。」等。Provider/model/prompt/debug情報はformatterから出しません。音声に含まれた語自体は記録対象です。Demoはraw、Gemini #1、semantic、candidates/routes、funnel/reasons、Gemini #2 input/output、normalization observations、D1/timingをMarkdown添付と短いpreviewで表示。大きなdebug生成はdemoのみです。

Alphaは追加していません。Demoも通常job/clip/checkpointを保存します。Owner accessは既存control-user判定を再利用します。

## 12. Migrations / local validation

0009: deadline/processing/stage/failure/checkpoint/presentation fields。0010: clipをデータ保持でrebuildしstation master FKを外し、railway_data_version追加、route_segment_connections→station_line_positions→stationsを削除。Legacy resolution IDsはlegacy-d1のaudit値、今後はstatic source hashを保存します。Historical migrationsは保持しました。

Fresh local D1全migration、master削除、FKチェック、Worker `/health`成功。Queue/Discord/fake AI integrationでもmaster削除後の状態を使用します。Jobとclipのraw upsert不変性を確認。通常のunit/integration testsは外部ネットワーク禁止です。実APIや本番migration/deployは未実施です。

[ローカル検証手順・コマンド・fixture一覧](local-validation.md)にLevel 1〜4、Workers AI/Geminiの必要範囲、fixture capture/replay、環境依存の確認を整理しています。

## 13. 精度評価

Precision/Recall/False Correction/Unresolvedの計算器・CLIと定義testあり。実音声gold corpusと実AIの結果がないため実値はすべてnull。Synthetic case数を100〜300件の実音声評価と見せかけていません。目標 >95% precision / 80〜90% recall / <2〜3% false correctionは未検証です。

## 14. Known risk classification

| Risk | 状態 | 根拠 / 実用上の限界 |
|---|---|---|
| findCandidatePools D1 scan | resolved | D1 adapter削除、fresh masterなしpipeline完了、static index候補探索 |
| instr() / OR条件 | resolved | Railway domain/adapterにSQLなし。Operational clip検索のORは別用途 |
| prefecture / line context膨張 | mitigated | Static gram/adjacency pool内でcontext評価、返却3+2上限。弱い1文字探索のCPUは残る |
| graph全ロード | mitigated | D1ロード0、static indexはisolateで一度。Startup bundle/メモリ負担は残る |
| top-5脱落 | mitigated | unique interval/強い前後anchor/lexicalを要求するrescueのpositive/negative unit test |
| single occurrence | mitigated | 強いroute/order/lexical/marginのみbind、弱い/phonetic/contradiction拒否unit test |
| Gemini #1 mention漏れ | observability only | static name scan＋demo差分、強制補正追加なし。誤認識した未知語の漏れは検出困難 |
| metadata完全一致依存 | mitigated | 旧helper削除、stable ID/roleで同期。ID欠落や複数同roleでの対応は不完全 |
| occurrence誤判定 / includes | mitigated | source span/ID、per-event出力、重複fixture。ModelのID欠落は観測のみ |
| Map上書き順序 | resolved | strongest-evidence mergeと入力順を反転したunit test |
| 12分 / 14分競合 | resolved | persisted16–20分deadline、deadline atomic UPDATE/回帰test |
| started_at曖昧 | resolved | processing/stage時計を別column、旧started_atをjob時計に使わない |
| public内部情報漏洩 | mitigated | public formatter＋public full-pipeline test。元音声/生成文章そのものにある語は別 |
| audio prompt injection | mitigated | untrusted JSON prompts/fixtures、実モデル耐性保証は残る。Hard output rejectionなし |
| Gemini自由補正 | observability only | 最新方針でtrust/reconstruction、数字/候補外/未知ID等の観測。事実誤生成を機械的に拒否しない |
| route全駅allowlist | resolved | allowedTargets自体なし。Routeの対応mention部分を参考材料として送信 |
| multilingual event loss | mitigated | raw/semantic全coverage、JA/EN別event、order/missing-event fallback tests。誤翻訳/scalar-onlyは保証しない |
| alpha D1 write leak | resolved | Alpha経路/type/repositoryを削除、2 presentation modesだけ |
| 性能・精度の本番保証 | still remaining | Node/local workerdの測定のみ。実音声gold/API・本番CPU/ピークmemory/Queue/Discord確認が必要 |
| long audio event batching | still remaining | 現在はevent構造化された単一AI request。時間順とprovenanceは保持 |

## 15. Evidence artifacts

- [local D1/Worker結果](benchmarks/local-verification.json)
- [D1→static same-input計測](benchmarks/d1-static-migration.json)
- [全国static microbenchmark](benchmarks/static-worker-memory.json)
- [Offline fixture出力](benchmarks/offline-fixtures.jsonl)
- [未測定の精度結果](benchmarks/accuracy.json)
- `tests/static-railway.integration.test.ts`: frozen D1 equivalence/integrity/branch/loop/regression
- `tests/correction-evidence.test.ts`: single/top-5/phonetic/contradiction/merge/Promise cache
- `tests/normalization-events.test.ts`: free prose/metadata/JA-EN/order/provenance/observations
- `tests/jobs-repository.integration.test.ts`: deadline前後/160秒/atomic race
- `tests/pipeline.integration.test.ts`: fresh migrations/public-demo/Queue checkpoint/raw immutability

## 最終検証結果

`npm run typecheck`成功。`npm test`はNode pure unit 80件、Worker integration/unit 130件成功（重複して実行するunit testも含む）。追加したmigration preservation testで既存clip/rawと未開始queued jobの時計を保持しました。`npm run verify:local`はfresh local D1へ全10migration適用、railway master削除、FK検証、Worker health成功。実APIへの通信、本番migration適用、deployは行っていません。

Bundleは同じWranglerによるdry-runでbefore 1,141.50 KiB / gzip 200.75 KiB、after 6,778.08 KiB / gzip 849.95 KiB。[測定結果](benchmarks/bundle-comparison.json)。Static master移行でbundleが増加しました。本番cold start・CPU・ピークメモリの計測は残課題です。

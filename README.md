# しろを塗る・屋上建築Web版

「[しろを塗る Castle Paint](https://store.steampowered.com/app/5254900/)」の拠点の屋上で、建物を組んで遊べるブラウザ版の体験版です。

- レンガ・ガラス・暖簾・大理石の建材を、ゲームと同じ三角の格子に置けます（押す: 床、長押し: 壁。板の端から壁の角へつなぐと坂、板の下に暖簾）。
- ゲームと同じように、建材の縦の壁をよじ登れます（壁へ向かって歩き続けると掴まり、上端でのり越える）。
- 1 分ごとに宝箱が降ってきます。開けると建材の補給カード（+10）を 3 枚から 1 枚えらべます。
- 屋上の建材を **JSON** で書き出し・読み込みできます。形式はゲーム本体と同じ（`siro_roof_build` v1）で、ゲームの「設定 → 拠点」の「JSON を書き出す／読み込む」とそのままやりとりできます。
- **3D 印刷データ（3MF）** をダウンロードできます（1/100。段ごとに分けて刷り、ダボで重ねる形。暖簾は棒と布を別に刷る）。Bambu Studio でパーツごとのフィラメントが分かれます。
- PC（キーボードとマウス）・スマホ（Android / iPhone のタッチ）・VR（WebXR。Meta Quest のブラウザなど）で動きます。

## 動かし方

ビルドはいりません。静的なファイルをそのまま配ります。コミットの前に `sh tools/stamp_version.sh` を流すと、画面の左上に出るビルド番号と時刻（`version.js`）が更新されます。

Windows では `start.bat` をダブルクリックすると、サーバーが立ち上がってブラウザで開きます（窓を閉じると止まります）。
中身は `python tools/serve.py 8765` です。ブラウザにキャッシュさせないので、ファイルを直したら読み込み直すだけで反映されます。

```sh
python tools/serve.py 8765
# http://localhost:8765/ を開く
```

## ファイル

| ファイル | 中身 |
| --- | --- |
| `js/wall.js` | 建材の置き方（ゲームの `placeable_wall.gd` の六角の建材を移したもの） |
| `js/roof_build_io.js` | JSON の読み書き（`roof_build_io.gd` と同じ形式） |
| `js/roof_print_export.js` | 3MF の書き出し（`roof_print_export.gd` を移したもの） |
| `js/roof.js` | 拠点の建物と屋上の形 |
| `js/main.js` | 移動・カメラ・建築・保存 |
| `js/xr.js` | VR の操作と右手のメニュー |
| `sample/roof_sample.json` | はじめに建っている見本 |

## クレジット

- `assets/models/player.glb`（しろ）: Tripo AI で作成（有料プランの商用ライセンス）
- `assets/cards/*.png`（カードの絵）: ChatGPT / DALL·E（OpenAI）で作成した AI 生成画像
- `assets/sfx/*.wav`（置く・回収・宝箱・着地・足音）: 開発者による自作（ゲーム本体と同じ音）
- `assets/textures/marble_white_diff_1k.jpg`: [Poly Haven](https://polyhaven.com) の marble_01（CC0）を色調整
- [three.js](https://threejs.org)（MIT, `vendor/three/LICENSE`）
- [fflate](https://github.com/101arrowz/fflate)（MIT, three.js に同梱）
- [polygon-clipping](https://github.com/mfogel/polygon-clipping)（MIT, `vendor/polygon-clipping.LICENSE.md`）

ゲームの絵・モデル・名前の権利は開発者（tatmos）にあります。コード（`js/`・`css/`・`index.html`）の再利用は自由ですが、アセットの再配布はご遠慮ください。

## リンク

- Steam: https://store.steampowered.com/app/5254900/
- Discord: https://discord.gg/5tVwyskeCd
- YouTube: https://www.youtube.com/@%E3%81%97%E3%82%8D%E3%82%92%E5%A1%97%E3%82%8BCastlePaint

# instant-internet
Create your fantasies on the internet. Eureka, at that instant.

- 各プロジェクトのビルドコマンド発火とか出力ディレクトリをコピーしたりはDenoで実行している
- ビルドコマンドのためにNodeもセットアップしている

## パフォーマンス系の改善策
- GitHub Action で並列にセットアップ走らせるようにしたほうがCIが早く終わりそう
- 差分のみのビルド、pnpmのディレクトリなど速度を改善する取り組みは結構大事そう
- 各プロジェクトはライブラリを使う場合、効率のために pnpm を使うほうが良さそう

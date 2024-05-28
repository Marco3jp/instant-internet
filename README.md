# instant-internet
Create your fantasies on the internet. Eureka, at that instant.

## イメージ
- サブディレクトリに雑なディレクトリを生やす
- 直下ディレクトリにデプロイコードを生やす
- 直下とサブの構造
  - 直下に、各デプロイの dir, command, distDir, accessName がほしい？
  - dir: 該当プロジェクトのディレクトリ
  - command: ビルドするのに必要なコマンド
  - ditDir: ビルドの成果物が出力されるディレクトリ
  - publicName: 成果物をGitHub Pagesにデプロイするとき、 `marco3jp.github.io/instant-internet/[publicName]` とするための名前
    - これだけはオプションで、なければdirがそのまま使われる


```json
{
    "eurekaes": [
        {
            dir: "summer-sky",
            command: "npm run build",
            distDir: "dist",
            publicName: "summer-sky"
        }
    ]
}
```
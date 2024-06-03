interface ProjectConfig {
    projectRoot: string
    eurekaes: Array<
        {
            dir: string
            // command がもし未定義ならコマンドの実行をスキップしてdistDirをコピーする処理に進む
            command?: string
            // distDir がもし未定義なら対象のディレクトリをそのままコピーする
            distDir?: string
            // publicName がもし未定義ならdir名を利用する
            publicName?: string
        }
    >
}

export default <ProjectConfig>{
    projectRoot: "projects",
    eurekaes: [
        {
            dir: "test-for-with-bundler",
            command: "npm run ci && npm run build -- --base=/instant-internet/test-for-with-bundler/",
            distDir: "dist"
        },
        {
            // HTMLファイルをコピーする系のテストプロジェクト
            dir: "test-for-vanilla-frontend",
        }
    ]
}
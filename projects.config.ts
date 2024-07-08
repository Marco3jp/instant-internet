export interface BuildCommand {
    exec: string
    args: Array<string>
}

interface ProjectConfig {
    projectRoot: string
    eurekaes: Array<
        {
            dir: string
            // commands がもし未定義ならコマンドの実行をスキップしてdistDirをコピーする処理に進む
            commands?: Array<BuildCommand>
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
            dir: "emoji-picker",
            commands: [
                {
                    exec: "npm",
                    args: ["ci"]
                },
                {
                    exec: "npm",
                    args: ["run", "build", "--", "--base=/instant-internet/emoji-picker/"]
                }
            ],
            distDir: "dist"
        },
        {
            dir: "load-to-apocalyptic",
        },
        {
            dir: "test-for-with-bundler",
            commands: [
                {
                    exec: "npm",
                    args: ["ci"]
                },
                {
                    exec: "npm",
                    args: ["run", "build", "--", "--base=/instant-internet/test-for-with-bundler/"]
                }
            ],
            distDir: "dist"
        },
        {
            // HTMLファイルをコピーする系のテストプロジェクト
            dir: "test-for-vanilla-frontend",
        }
    ]
}
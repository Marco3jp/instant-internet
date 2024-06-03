import config from "./projects.config.ts"

async function buildAndCopyAllProject() {
    // 一時的に全プロジェクトの成果物を置くディレクトリを作る
    await Deno.mkdir("dist")

    // とりあえずプロジェクトは直列でビルドする
    config.eurekaes.forEach(async (eureka) => {
        const processes = [];

        processes.push(`pushd ./${config.projectRoot}/`)

        if (eureka.command) {
            processes.push(eureka.command)
        }

        // ここまではプロジェクトルートのスコープで実行する
        // popdして一旦戻ってからいい感じにやる
        processes.push(`popd`)
        processes.push(`cp -r ./${eureka.dir}/${eureka.distDir || ""} ./dist/${eureka.publicName || eureka.dir}`)

        // && で結合すると成功したときだけ次のコマンドが実行されるらしいよ
        const command = new Deno.Command(processes.join(" && "))
        const {code, stdout, stderr} = await command.output()
        console.log(stdout)
        
        if (code !== 0) {
            console.error(stderr)
            // エラーが出てもとりあえず次のプロジェクトのビルドに進む
        }
    })
}

async function checkPermission() {
    // NOTE: readに関しては設定自体tsファイルにしていてimportしているので大丈夫そう
    // THOUGHT: いや、大丈夫だけど、事前にわかっている範囲のpermissionモデルは仕方ないとはいえ面倒な感じはあるなぁ
    //   --allow-write=dist --allow-run --no-prompt とかで走らせるんだろうけど、CIなので事前に確定している結末なわけで……

    // 出力をまとめるためのディレクトリを作るために必要
    await Deno.permissions.query({ name: "write", path: "dist" })
    
    // 各プロジェクトのビルドを走らせるのに必要
    await Deno.permissions.query({ name: "run" })
}

async function main() {
    await checkPermission()
    await buildAndCopyAllProject()
}

main()
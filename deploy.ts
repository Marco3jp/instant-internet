import { copy } from "https://deno.land/std@0.224.0/fs/copy.ts";

import config, { BuildCommand } from "./projects.config.ts"

async function runBuildCommands(commands: Array<BuildCommand>) {
    for (const command of commands) {
        const childProcess = new Deno.Command(command.exec, { args: command.args, stdout: "piped", stderr: "piped" }).spawn()
        const out = await childProcess.output()

        console.log(new TextDecoder().decode(out.stdout))
        if (out.stderr) {
            console.error(new TextDecoder().decode(out.stderr))
        }
    }
}

async function buildAndCopyAllProject() {
    const initialCwd = Deno.cwd();

    // とりあえずプロジェクトは直列でビルドする
    for (const eureka of config.eurekaes) {
        Deno.chdir(config.projectRoot + "/" + eureka.dir) // pushd

        if (eureka.commands) {
            await runBuildCommands(eureka.commands)
        }

        Deno.chdir(initialCwd) // popd

        try {
            await copy(`./${config.projectRoot}/${eureka.dir}/${eureka.distDir || ""}`, `./dist/${eureka.publicName || eureka.dir}`)
        } catch (e) {
            if (!(e instanceof Deno.errors.AlreadyExists)) {
                console.error(e)
            }

            // すでにディレクトリが存在している場合はそのまま継続
        }
    }
}

// 多分権限がなければ落ちるはずなので、まあそれでいいかなと思ってエラーハンドリング書いてない
async function checkPermission() {
    // NOTE: readに関しては設定自体tsファイルにしていてimportしているので大丈夫そう
    // THOUGHT: いや、大丈夫だけど、事前にわかっている範囲のpermissionモデルは仕方ないとはいえ面倒な感じはあるなぁ
    //   --allow-write=dist --allow-run --no-prompt とかで走らせるんだろうけど、CIなので事前に確定している結末なわけで……

    // 出力をコピーするのに必要
    await Deno.permissions.query({ name: "read" })
    await Deno.permissions.query({ name: "write" })
    
    // 各プロジェクトのビルドを走らせるのに必要
    await Deno.permissions.query({ name: "run" })
}

async function main() {
    await checkPermission()
    await buildAndCopyAllProject()
}

main()
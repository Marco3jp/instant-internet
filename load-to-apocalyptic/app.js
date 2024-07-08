function renderHistoryItem(author, text) {
    const item = document.createElement("li");
    item.textContent = `${author}: ${text}`;
    document.querySelector("#history").appendChild(item);
}

// 送って返ってくるのを待つまでやるので良い名前がほしい感じ
async function callPrompt() {
    const prompt = document.querySelector("#prompt").value.trim()
    renderHistoryItem("You", prompt)
    document.querySelector("#prompt").value = ""

    document.querySelector("#loading").classList.remove("hidden")
    const responce = await session.prompt(prompt)
    document.querySelector("#loading").classList.add("hidden")
    renderHistoryItem("Gemini Nano", responce)
}

function onClickCallPrompt() {
    callPrompt()
}
let session = null

window.ai.createTextSession().then(s => session = s)
document.querySelector("#call-prompt").addEventListener("click", onClickCallPrompt)
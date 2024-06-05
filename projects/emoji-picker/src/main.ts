import './style.css'
import {Picker} from 'emoji-mart'

let clearId: number | null = null;
const dialog = <HTMLDialogElement>document.querySelector("#copied-dialog")

// @ts-ignore
async function copyEmoji(emoji) {
  // 見栄えびみょ～かもしれんがちらつくくらいならマシかな～という気持ちで削除キャンセルする
  if (clearId) clearTimeout(clearId)

  await navigator.clipboard.writeText(emoji.native);
  dialog.show()

  clearId = setTimeout(()=> {
    clearId = null;
    dialog.close()
  }, 1500)
}

const pickerOptions = {
   onEmojiSelect: copyEmoji,
   theme: "dark",
   autoFocus: true,
   emojiButtonSize: 36 * 2,
   emojiSize: 24 * 2,
   dynamicWidth: true,
  }
const picker = new Picker(pickerOptions)

// @ts-ignore
document.body.appendChild(picker)
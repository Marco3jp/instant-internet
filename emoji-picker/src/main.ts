import './style.css'
import {Picker} from 'emoji-mart'

// @ts-ignore
async function copyEmoji(emoji) {
  await navigator.clipboard.writeText(emoji.native);
}

const pickerOptions = {
   onEmojiSelect: copyEmoji,
   theme: "dark",
   dynamicWidth: true
  }
const picker = new Picker(pickerOptions)

// @ts-ignore
document.body.appendChild(picker)
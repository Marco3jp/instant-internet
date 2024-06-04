import {Picker} from 'emoji-mart'

async function copyEmoji(emoji) {
  await navigator.clipboard.writeText(emoji.native);
}

const pickerOptions = { onEmojiSelect: copyEmoji }
const picker = new Picker(pickerOptions)

document.body.appendChild(picker)
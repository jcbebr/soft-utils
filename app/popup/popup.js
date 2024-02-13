import { getCurrentTab, getStorage, isOptionsPage, isStartPage, setCssPropertyValue } from '../utils.js'

const buttonFillCt = document.getElementById('fillCt')

getStorage((data) => {
  setCssPropertyValue('--colorBackground', data.colorBackground)
  setCssPropertyValue('--colorText', data.colorText)
});

buttonFillCt.addEventListener('click', async () => {
  const currentTab = await getCurrentTab()
  if (isStartPage(currentTab) === true || isOptionsPage(currentTab) === true) return

  chrome.scripting.executeScript({
    target: { tabId: currentTab[0].id },
    func: fillCt
  });
});

function fillCt() {
  function sanitizeContent(content) {
    return content.replace('\n', '').replace(/[^\x00-\x80]/g, '').trimLeft().trimRight()
  }

  chrome.storage.sync.get((data) => {
    const fillCt = String(data.fillCt).toLowerCase().split(', ')

    const headers = document.querySelector('.description').querySelectorAll('h1, h2, h3')
    if (!headers) return

    const headersContainingCt = Array.from(headers).map(value => value.textContent).filter(value => {
      return fillCt.filter((ct) => {
        return value.toLowerCase().includes(ct)
      }).length > 0
    })
    if (!headersContainingCt) return

    const content = '\nCT :white_check_mark:\n\n' + headersContainingCt.map(
      value => '<details><summary>:page_facing_up: ' +
        sanitizeContent(value) +
        ' :white_check_mark: </summary>\n' +
        '{width=100%}\n' +
        '</details>').join('\n\n')

    const textarea = document.querySelector('.js-comment-form').querySelector('textarea')
    textarea.focus()
    document.execCommand('insertText', false, content);
  })

}
import { getCurrentTab, getStorage, isOptionsPage, isStartPage, setCssPropertyValue } from '../utils.js'

const buttonFillCt = document.getElementById('fillCt')
const buttonScanKanban = document.getElementById('scanKanban')
const kanbanMissingList = document.getElementById('kanbanMissingList')
const kanbanMissingChangelogList = document.getElementById('kanbanMissingChangelogList')
const kanbanApprovalsList = document.getElementById('kanbanApprovalsList')
const kanbanLastRun = document.getElementById('kanbanLastRun')

getStorage((data) => {
  const colorBackground = data.colorBackground || '#1d4c58'
  const colorText = data.colorText || '#ffffff'
  setCssPropertyValue('--colorBackground', colorBackground)
  setCssPropertyValue('--colorText', colorText)
  renderKanbanStatus(data)
});

buttonFillCt.addEventListener('click', async () => {
  const currentTab = await getCurrentTab()
  if (isStartPage(currentTab) === true || isOptionsPage(currentTab) === true) return

  chrome.scripting.executeScript({
    target: { tabId: currentTab[0].id },
    func: fillCt
  });
});

buttonScanKanban.addEventListener('click', () => {
  if (kanbanLastRun) kanbanLastRun.textContent = 'Scanning...'
  chrome.runtime.sendMessage({ type: 'scanKanbanBoard' })
})

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return
  if (changes.kanbanMissingTasks || changes.kanbanMissingChangelogTasks || changes.kanbanApprovals || changes.kanbanLastRunAt) {
    getStorage((data) => renderKanbanStatus(data))
  }
})

function renderKanbanStatus(data) {
  if (!kanbanMissingList || !kanbanMissingChangelogList || !kanbanApprovalsList || !kanbanLastRun) return

  const missingTasks = Array.isArray(data.kanbanMissingTasks) ? data.kanbanMissingTasks : []
  const missingChangelogTasks = Array.isArray(data.kanbanMissingChangelogTasks)
    ? data.kanbanMissingChangelogTasks
    : []
  const approvals = Array.isArray(data.kanbanApprovals) ? data.kanbanApprovals : []
  const lastRunAt = data.kanbanLastRunAt ? new Date(data.kanbanLastRunAt) : null
  kanbanLastRun.textContent = lastRunAt ? `Last scan: ${lastRunAt.toLocaleString()}` : 'No scans yet'

  kanbanMissingList.innerHTML = ''
  if (missingTasks.length === 0) {
    const item = document.createElement('li')
    item.textContent = 'No missing MRs'
    kanbanMissingList.appendChild(item)
  }

  missingTasks.forEach((taskId) => {
    const item = document.createElement('li')
    item.textContent = taskId
    kanbanMissingList.appendChild(item)
  })

  kanbanMissingChangelogList.innerHTML = ''
  if (missingChangelogTasks.length === 0) {
    const item = document.createElement('li')
    item.textContent = 'No missing changelog'
    kanbanMissingChangelogList.appendChild(item)
  }

  missingChangelogTasks.forEach((taskId) => {
    const item = document.createElement('li')
    item.textContent = taskId
    kanbanMissingChangelogList.appendChild(item)
  })

  kanbanApprovalsList.innerHTML = ''
  if (approvals.length === 0) {
    const item = document.createElement('li')
    item.textContent = 'No approvals data'
    kanbanApprovalsList.appendChild(item)
    return
  }

  approvals.forEach((entry) => {
    const item = document.createElement('li')
    const approvalsValue = typeof entry.approvals === 'number' ? entry.approvals : 'n/a'
    item.textContent = `${entry.mrUrl} (${approvalsValue})`
    kanbanApprovalsList.appendChild(item)
  })
}

function fillCt() {
  function sanitizeContent(content) {
    return content.replace(/[\r\n]+/g, ' ').replace(/[^\x00-\x80]/g, '').trim()
  }

  chrome.storage.sync.get((data) => {
    const fillCt = String(data.fillCt || '').toLowerCase().split(', ').filter(Boolean)
    if (fillCt.length === 0) return

    const description = document.querySelector('.description')
    if (!description) return

    const headers = description.querySelectorAll('h1, h2, h3')
    if (!headers || headers.length === 0) return

    const headersContainingCt = Array.from(headers).map(value => value.textContent).filter(value => {
      return fillCt.filter((ct) => {
        return value.toLowerCase().includes(ct)
      }).length > 0
    })
    if (!headersContainingCt || headersContainingCt.length === 0) return

    const content = '\nCT :white_check_mark:\n\n' + headersContainingCt.map(
      value => '<details><summary>:page_facing_up: ' +
        sanitizeContent(value) +
        ' :white_check_mark: </summary>\n' +
        '{width=100%}\n' +
        '</details>').join('\n\n')

    const commentForm = document.querySelector('.js-comment-form')
    if (!commentForm) return
    const textarea = commentForm.querySelector('textarea')
    if (!textarea) return
    textarea.focus()
    document.execCommand('insertText', false, content);
  })

}
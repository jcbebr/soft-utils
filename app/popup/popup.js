import { getCurrentTab, getStorage, isOptionsPage, isStartPage, setCssPropertyValue } from '../utils.js'

const buttonFillCt = document.getElementById('fillCt')
const buttonScanKanban = document.getElementById('scanKanban')
const scanKanbanHint = document.getElementById('scanKanbanHint')
const buttonDebug = document.getElementById('debug')
const debugPanel = document.getElementById('debugPanel')
const debugLastRun = document.getElementById('debugLastRun')
const debugNextScan = document.getElementById('debugNextScan')
const debugCountGitlab = document.getElementById('debugCountGitlab')
const debugCountSesuite = document.getElementById('debugCountSesuite')
const debugTableBody = document.getElementById('debugTableBody')
const buttonDebugClear = document.getElementById('debugClear')

getStorage((data) => {
  const colorBackground = data.colorBackground || '#1d4c58'
  const colorText = data.colorText || '#ffffff'
  setCssPropertyValue('--colorBackground', colorBackground)
  setCssPropertyValue('--colorText', colorText)
})

buttonFillCt.addEventListener('click', async () => {
  const currentTab = await getCurrentTab()
  if (isStartPage(currentTab) === true || isOptionsPage(currentTab) === true) return

  chrome.scripting.executeScript({
    target: { tabId: currentTab[0].id },
    func: fillCt
  })
})

buttonScanKanban.addEventListener('click', () => {
  console.log('[soft-utils] popup: Scan Kanban clicked')
  if (scanKanbanHint) scanKanbanHint.textContent = 'Scanning…'
  chrome.runtime.sendMessage({ type: 'scanKanbanBoard' }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('[soft-utils] popup: sendMessage failed:', chrome.runtime.lastError.message)
      clearScanHint()
      return
    }
    console.log('[soft-utils] popup: scan response:', response)
    if (response && response.ok === false) {
      console.warn(
        '[soft-utils] popup: scan did not complete:',
        response.reason,
        response.error || ''
      )
      clearScanHint()
      setTimeout(() => updateNextScanDisplay(), 0)
    }
  })
})

const KANBAN_STORAGE_KEYS = [
  'kanbanMissingTasks',
  'kanbanMissingChangelogTasks',
  'kanbanApprovals',
  'kanbanLastRunAt',
  'kanbanTaskDetails'
]

let nextScanIntervalId = null

function clearNextScanInterval() {
  if (nextScanIntervalId != null) {
    clearInterval(nextScanIntervalId)
    nextScanIntervalId = null
  }
}

buttonDebug.addEventListener('click', () => {
  if (!debugPanel) return
  const show = debugPanel.hidden
  debugPanel.hidden = !show
  if (show) {
    renderDebugPanel()
    clearNextScanInterval()
    nextScanIntervalId = setInterval(updateNextScanDisplay, 1000)
  } else {
    clearNextScanInterval()
  }
})

if (buttonDebugClear) {
  buttonDebugClear.addEventListener('click', () => {
    if (
      !window.confirm(
        'Remove all kanban scan results from sync storage and reset API request counters? Options (tokens, colors) are kept.'
      )
    ) {
      return
    }
    chrome.storage.sync.remove(KANBAN_STORAGE_KEYS, () => {
      chrome.storage.local.remove(['apiRequestCounts'], () => {
        renderDebugPanel()
      })
    })
  })
}

function clearScanHint() {
  if (scanKanbanHint) scanKanbanHint.textContent = ''
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && (changes.kanbanLastRunAt || changes.kanbanTaskDetails)) {
    clearScanHint()
    setTimeout(() => updateNextScanDisplay(), 0)
  }
  if (debugPanel && !debugPanel.hidden) {
    if (areaName === 'local' && changes.apiRequestCounts) {
      renderDebugPanel()
    } else if (areaName === 'sync') {
      renderDebugPanel()
    }
  }
})

function loadDebugData(callback) {
  chrome.storage.sync.get(['kanbanLastRunAt', 'kanbanTaskDetails'], (syncData) => {
    chrome.storage.local.get(['apiRequestCounts'], (localData) => {
      callback(syncData, localData)
    })
  })
}

function formatDurationUntilMs(ms) {
  if (ms <= 0) return 'due now'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m ${sec}s`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

function updateNextScanDisplay() {
  if (!debugNextScan) return
  chrome.alarms.get('kanbanSync', (alarm) => {
    if (chrome.runtime.lastError || !alarm || typeof alarm.scheduledTime !== 'number') {
      debugNextScan.textContent = 'Next scan: not scheduled'
      return
    }
    const ms = alarm.scheduledTime - Date.now()
    if (ms <= 0) {
      debugNextScan.textContent = 'Next scan: due now'
      return
    }
    const at = new Date(alarm.scheduledTime)
    debugNextScan.textContent = `Next scan in: ${formatDurationUntilMs(ms)} (at ${at.toLocaleTimeString()})`
  })
}

function normalizeLaneNameDisplay(raw) {
  if (raw == null || String(raw).trim() === '') return ''
  const collapsed = String(raw).replace(/\s+/g, ' ').trim()
  const withoutLeadingCount = collapsed.replace(/^\d+/, '').trim()
  return withoutLeadingCount || collapsed
}

function formatMrShortLabel(mrUrl) {
  if (typeof mrUrl !== 'string' || !mrUrl) return '—'
  const projectName = mrUrl.split('/-/')[0].split('/').slice(-1)[0] || mrUrl
  const mrMatch = mrUrl.match(/merge_requests\/(\d+)/i)
  const mrIid = mrMatch && mrMatch[1] ? mrMatch[1] : '?'
  return `${projectName} #${mrIid}`
}

function formatMrCell(mrs) {
  if (!Array.isArray(mrs) || mrs.length === 0) return '—'
  return mrs
    .map((m) => {
      const url = typeof m.mrUrl === 'string' ? m.mrUrl : ''
      const appr = typeof m.approvals === 'number' ? m.approvals : 'n/a'
      const label = formatMrShortLabel(url)
      return `${label} (${appr})`
    })
    .join('\n')
}

function renderDebugPanel() {
  if (!debugPanel || !debugCountGitlab || !debugCountSesuite || !debugTableBody) return
  loadDebugData((syncData, localData) => {
    const counts = localData.apiRequestCounts || { gitlab: 0, sesuite: 0 }
    debugCountGitlab.textContent = String(counts.gitlab ?? 0)
    debugCountSesuite.textContent = String(counts.sesuite ?? 0)

    const lastRunAt = syncData.kanbanLastRunAt ? new Date(syncData.kanbanLastRunAt) : null
    if (debugLastRun) {
      debugLastRun.textContent = lastRunAt ? `Last scan: ${lastRunAt.toLocaleString()}` : 'No scans yet'
    }

    updateNextScanDisplay()

    debugTableBody.innerHTML = ''
    const rows = Array.isArray(syncData.kanbanTaskDetails) ? syncData.kanbanTaskDetails : []
    if (rows.length === 0) {
      const tr = document.createElement('tr')
      const td = document.createElement('td')
      td.colSpan = 9
      td.className = 'su-debug-empty'
      td.textContent = 'No task details yet. Run a kanban scan.'
      tr.appendChild(td)
      debugTableBody.appendChild(tr)
    } else {
    rows.forEach((row) => {
      const tr = document.createElement('tr')
      const taskId = row.taskId != null ? String(row.taskId) : ''
      const laneRaw =
        row.laneName != null && String(row.laneName).trim() !== ''
          ? String(row.laneName)
          : ''
      const lane = laneRaw ? normalizeLaneNameDisplay(laneRaw) || '—' : '—'
      const laneId =
        row.laneId != null && String(row.laneId).trim() !== ''
          ? String(row.laneId)
          : '—'
      const skipChecks = Boolean(row.skipChecks)
      const missMr = Boolean(row.missingMr)
      const missCl = Boolean(row.missingChangelog)
      const lowAp = Boolean(row.lowApprovals)
      const requiresCr = Boolean(row.requiresCrCheck)
      const requiresCt = Boolean(row.requiresCtCheck)
      const lowCr = Boolean(row.lowCrAssignees)
      const missCt = Boolean(row.missingCtAssignees)
      const crCell = requiresCr
        ? `<td class="${lowCr ? 'su-debug-yes' : 'su-debug-no'}">${lowCr ? 'Yes' : 'No'}</td>`
        : '<td class="su-debug-na">—</td>'
      const ctCell = requiresCt
        ? `<td class="${missCt ? 'su-debug-yes' : 'su-debug-no'}">${missCt ? 'Yes' : 'No'}</td>`
        : '<td class="su-debug-na">—</td>'
      if (skipChecks) {
        tr.innerHTML =
          `<td>${escapeHtml(taskId)}</td>` +
          `<td class="su-debug-lane">${escapeHtml(lane)}</td>` +
          `<td class="su-debug-lane-id">${escapeHtml(laneId)}</td>` +
          '<td class="su-debug-na">—</td>' +
          '<td class="su-debug-na">—</td>' +
          '<td class="su-debug-na">—</td>' +
          '<td class="su-debug-na">—</td>' +
          '<td class="su-debug-na">—</td>' +
          '<td class="su-debug-mrs">—</td>'
      } else {
        tr.innerHTML =
          `<td>${escapeHtml(taskId)}</td>` +
          `<td class="su-debug-lane">${escapeHtml(lane)}</td>` +
          `<td class="su-debug-lane-id">${escapeHtml(laneId)}</td>` +
          `<td class="${missMr ? 'su-debug-yes' : 'su-debug-no'}">${missMr ? 'Yes' : 'No'}</td>` +
          `<td class="${missCl ? 'su-debug-yes' : 'su-debug-no'}">${missCl ? 'Yes' : 'No'}</td>` +
          `<td class="${lowAp ? 'su-debug-yes' : 'su-debug-no'}">${lowAp ? 'Yes' : 'No'}</td>` +
          crCell +
          ctCell +
          '<td class="su-debug-mrs"></td>'
        const mrsCell = tr.querySelector('.su-debug-mrs')
        if (mrsCell) mrsCell.textContent = formatMrCell(row.mrs)
      }
      debugTableBody.appendChild(tr)
    })
    }
  })
}

function escapeHtml(text) {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
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
    document.execCommand('insertText', false, content)
  })
}

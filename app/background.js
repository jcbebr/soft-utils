const DEFAULTS = {
  colorBackground: '#1d4c58',
  colorText: '#ffffff',
  fillCt: '📄',
  kanbanPageUrl: '',
  kanbanIntervalMinutes: 10,
  kanbanWorkspaceId: '310',
  gitlabToken: ''
}

/**
 * Canonical Kanban lanes (order = typical left-to-right on the board).
 * `checks`: reserved for future per-lane validation (e.g. task attributes in "Testing").
 */
const KANBAN_LANE_CONFIG = [
  { id: 'todo', label: 'To do', checks: null },
  { id: 'in_progress', label: 'In Progress', checks: null },
  { id: 'code_review', label: 'Code Review', checks: null },
  { id: 'last_review', label: 'Last Review', checks: null },
  { id: 'ready_to_test', label: 'Ready to Test', checks: null },
  { id: 'testing', label: 'Testing', checks: null },
  { id: 'rehab', label: 'Rehab', checks: null },
  { id: 'ready_to_merge', label: 'Ready to Merge', checks: null },
  { id: 'closed', label: 'Closed', checks: null }
]

function getKanbanLaneConfigForPageScript() {
  return KANBAN_LANE_CONFIG.map(({ id, label }) => ({ id, label }))
}

const KANBAN_LANE_ORDER = KANBAN_LANE_CONFIG.map((l) => l.id)

function laneOrderIndex(laneId) {
  if (typeof laneId !== 'string') return -1
  return KANBAN_LANE_ORDER.indexOf(laneId)
}

function isLaneAtOrAfter(laneId, minLaneId) {
  const a = laneOrderIndex(laneId)
  const b = laneOrderIndex(minLaneId)
  if (a < 0 || b < 0) return false
  return a >= b
}

/** Last Review onward: stricter bar (3 GitLab approvals per MR, 3 CR devs). */
function minGitlabApprovalsForLane(laneId) {
  if (!laneId) return 2
  return isLaneAtOrAfter(laneId, 'last_review') ? 3 : 2
}

function minCrAssigneesForLane(laneId) {
  if (!laneId) return 0
  if (isLaneAtOrAfter(laneId, 'last_review')) return 3
  if (isLaneAtOrAfter(laneId, 'code_review')) return 2
  return 0
}

function countSesiuteUserListValues(values) {
  if (!Array.isArray(values)) return 0
  return values.filter((v) => v != null && String(v).trim() !== '').length
}

function isCrAssigneeAttribute(attr) {
  const s = String(attr.nmlabel || '').toLowerCase()
  return s.includes('pelo cr') && !s.includes('obsoleto')
}

function isCtAssigneeAttribute(attr) {
  const s = String(attr.nmlabel || '').toLowerCase()
  return s.includes('pelo ct') && !s.includes('obsoleto')
}

function setDefaultValue(key, value) {
  chrome.storage.sync.get(key, (data) => {
    if (typeof data[key] === 'undefined') {
      const payload = {}
      payload[key] = value
      chrome.storage.sync.set(payload)
    }
  })
}

function updateKanbanAlarm(periodMinutes) {
  const safeMinutes = Math.max(1, Number(periodMinutes) || DEFAULTS.kanbanIntervalMinutes)
  chrome.alarms.clear('kanbanSync', () => {
    chrome.alarms.create('kanbanSync', { periodInMinutes: safeMinutes })
  })
}

function getStorageValues(keys) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(keys, resolve)
  })
}

function queryTabs(queryInfo) {
  return new Promise((resolve) => {
    chrome.tabs.query(queryInfo, resolve)
  })
}

function executeScript(details) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(details, (results) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }
      resolve(results)
    })
  })
}

function incrementApiRequestCount(kind) {
  chrome.storage.local.get(['apiRequestCounts'], (data) => {
    const counts = data.apiRequestCounts || { gitlab: 0, sesuite: 0 }
    counts[kind] = (counts[kind] || 0) + 1
    chrome.storage.local.set({ apiRequestCounts: counts })
  })
}

function getSesOriginFromKanbanPageUrl(kanbanPageUrl) {
  if (!kanbanPageUrl || typeof kanbanPageUrl !== 'string') return ''
  try {
    return new URL(kanbanPageUrl.trim()).origin
  } catch {
    return ''
  }
}

async function fetchTaskData(idtask, cdworkspace, sesOrigin) {
  if (!idtask || !cdworkspace || !sesOrigin) return ''
  incrementApiRequestCount('sesuite')
  const formData = new URLSearchParams({
    idtask,
    cdworkspace,
    action: '2',
    view: '2'
  })
  const taskDataUrl = `${sesOrigin}/se/task/rest/taskData.php`
  const response = await fetch(taskDataUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
    },
    credentials: 'include',
    body: formData.toString()
  })
  return await response.text()
}

function extractTaskAttributes(taskDataText) {
  if (!taskDataText) {
    return {
      mrUrls: [],
      changelogValues: [],
      crAssigneeCount: 0,
      ctAssigneeCount: 0
    }
  }
  let payload = null
  try {
    payload = JSON.parse(taskDataText)
  } catch (error) {
    return {
      mrUrls: [],
      changelogValues: [],
      crAssigneeCount: 0,
      ctAssigneeCount: 0
    }
  }

  const results = payload && payload.results && Array.isArray(payload.results) ? payload.results : []
  const urls = []
  const changelogValues = []
  let crAssigneeCount = 0
  let ctAssigneeCount = 0

  results.forEach((result) => {
    const attributes = result && Array.isArray(result.attributeList) ? result.attributeList : []
    const gitAttribute = attributes.find((attr) => String(attr.nmlabel || '').toLowerCase() === 'git')
    const changelogAttribute = attributes.find((attr) => String(attr.nmlabel || '').toLowerCase() === 'changelog')
    const values = gitAttribute && Array.isArray(gitAttribute.values) ? gitAttribute.values : []
    const changelog = changelogAttribute && Array.isArray(changelogAttribute.values)
      ? changelogAttribute.values
      : []
    values.forEach((value) => {
      if (typeof value !== 'string') return
      value.split(/\s+/).forEach((part) => {
        if (part.startsWith('http://') || part.startsWith('https://')) {
          urls.push(part.trim())
        }
      })
    })
    changelog.forEach((value) => {
      changelogValues.push(value)
    })

    attributes.forEach((attr) => {
      if (isCrAssigneeAttribute(attr)) {
        const n = countSesiuteUserListValues(attr.values)
        if (n > crAssigneeCount) crAssigneeCount = n
      }
      if (isCtAssigneeAttribute(attr)) {
        const n = countSesiuteUserListValues(attr.values)
        if (n > ctAssigneeCount) ctAssigneeCount = n
      }
    })
  })

  const mrIds = []
  urls.forEach((urlValue) => {
    try {
      const parsed = new URL(urlValue)
      const match = parsed.pathname.match(/merge_requests\/(\d+)/i)
      if (match && match[1]) mrIds.push(urlValue)
    } catch (error) {
      return
    }
  })

  return {
    mrUrls: Array.from(new Set(mrIds)),
    changelogValues,
    crAssigneeCount,
    ctAssigneeCount
  }
}

async function fetchGitlab(url, token) {
  return await fetch(url, {
    headers: {
      'PRIVATE-TOKEN': token
    }
  })
}

async function fetchGitlabJson(url, token) {
  incrementApiRequestCount('gitlab')
  const response = await fetchGitlab(url, token)
  if (!response.ok) return null
  try {
    return await response.json()
  } catch (error) {
    return null
  }
}

function getGitlabOrigin(mrUrl) {
  try {
    const parsed = new URL(mrUrl)
    return `${parsed.protocol}//${parsed.host}`
  } catch (error) {
    return ''
  }
}

function getMergeRequestProjectInfo(mrUrl) {
  try {
    const parsed = new URL(mrUrl)
    const path = parsed.pathname
    const mrIndex = path.indexOf('/-/merge_requests/')
    if (mrIndex === -1) return { projectPath: '', mrIid: '' }
    const projectPath = path.slice(1, mrIndex)
    const mrIid = path.slice(mrIndex + '/-/merge_requests/'.length).split('/')[0]
    return { projectPath, mrIid }
  } catch (error) {
    return { projectPath: '', mrIid: '' }
  }
}

async function callGitlabForMr(mrUrl, token) {
  const baseUrl = getGitlabOrigin(mrUrl)
  const info = getMergeRequestProjectInfo(mrUrl)
  if (!baseUrl || !token || !info.projectPath || !info.mrIid) return
  const encodedProject = encodeURIComponent(info.projectPath)
  const approvals = await fetchGitlabJson(
    `${baseUrl}/api/v4/projects/${encodedProject}/merge_requests/${info.mrIid}/approvals`,
    token
  )
  const approvedBy = approvals && Array.isArray(approvals.approved_by)
    ? approvals.approved_by.length
    : null
  return approvedBy
}

function collectKanbanTasks(pageUrl, laneConfig) {
  function normalizeLaneName(raw) {
    if (typeof raw !== 'string') return ''
    const collapsed = raw.replace(/\s+/g, ' ').trim()
    const withoutLeadingCount = collapsed.replace(/^\d+/, '').trim()
    return withoutLeadingCount || collapsed
  }

  function laneKeyFromLabel(label) {
    return normalizeLaneName(typeof label === 'string' ? label : '').toLowerCase()
  }

  const lanes = Array.isArray(laneConfig) ? laneConfig : []
  const configByLaneKey = new Map()
  lanes.forEach((entry) => {
    if (entry && typeof entry.id === 'string' && typeof entry.label === 'string') {
      configByLaneKey.set(laneKeyFromLabel(entry.label), entry)
    }
  })

  function kanbanPageMatches(href, configured) {
    if (!configured || typeof configured !== 'string') return false
    const trimmed = configured.trim()
    if (!trimmed) return false
    try {
      const cur = new URL(href)
      const cfg = new URL(trimmed)
      if (cur.origin !== cfg.origin) return false
      const normPath = (p) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p)
      if (normPath(cur.pathname) !== normPath(cfg.pathname)) return false
      if (cfg.search === '') return true
      const curParams = cur.searchParams
      const cfgParams = cfg.searchParams
      for (const key of cfgParams.keys()) {
        const want = cfgParams.getAll(key)
        const have = curParams.getAll(key)
        if (want.length !== have.length) return false
        for (let i = 0; i < want.length; i++) {
          if (have[i] !== want[i]) return false
        }
      }
      return true
    } catch {
      return href.startsWith(trimmed)
    }
  }

  const href = window.location.href
  if (!pageUrl || !kanbanPageMatches(href, pageUrl)) {
    return {
      tasks: [],
      reason: 'url-mismatch',
      href,
      configured: pageUrl
    }
  }

  const laneHeaders = document.querySelectorAll('.LaneHeader')
  const laneBodies = document.querySelectorAll('.LaneBody')

  if (!laneHeaders || laneHeaders.length === 0) return { tasks: [], reason: 'no-lane-headers' }
  if (!laneBodies || laneBodies.length === 0) return { tasks: [], reason: 'no-lane-bodies' }

  const taskById = new Map()
  laneHeaders.forEach((header, index) => {
    const laneBody = laneBodies[index]
    if (!laneBody) return
    const laneName = normalizeLaneName(header.textContent || '')
    const laneKey = laneKeyFromLabel(laneName)
    const laneEntry = configByLaneKey.get(laneKey)
    if (!laneEntry) return

    const cards = laneBody.querySelectorAll('[data-test-selector="rctCardBase"]')

    if (!cards || cards.length === 0) return
    cards.forEach((card) => {
      const span = card.querySelector('.Card__identifier a')
      const idtask = span && span.innerText ? span.innerText.trim() : ''
      if (!idtask || taskById.has(idtask)) return
      taskById.set(idtask, {
        taskId: idtask,
        laneName,
        laneId: laneEntry.id
      })
    })
  })

  const tasks = Array.from(taskById.values())
  if (tasks.length === 0) {
    return {
      tasks: [],
      reason: 'no-cards-in-lanes',
      laneHeaderCount: laneHeaders.length,
      laneBodyCount: laneBodies.length
    }
  }

  return { tasks }
}

function injectWarnings(taskWarnings) {
  // Remove previous warnings
  document.querySelectorAll('.su-warn-badge, .su-warn-overlay').forEach(el => el.remove())

  // Inject styles once
  if (!document.getElementById('su-warn-styles')) {
    const style = document.createElement('style')
    style.id = 'su-warn-styles'
    style.textContent = `
      .su-warn-badge {
        position: absolute;
        top: -2px;
        right: 28px;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: #ef4444;
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        z-index: 50;
        box-shadow: 0 1px 4px rgba(0,0,0,0.18);
        border: 2px solid #fff;
        transition: transform 0.15s ease, box-shadow 0.15s ease;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        line-height: 1;
      }
      .su-warn-badge:hover {
        transform: scale(1.15);
        box-shadow: 0 2px 8px rgba(239,68,68,0.4);
      }
      .su-warn-badge--yellow {
        background: #f59e0b;
      }
      .su-warn-overlay {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0,0,0,0.35);
        backdrop-filter: blur(2px);
        animation: su-fade-in 0.15s ease;
      }
      @keyframes su-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      .su-warn-popup {
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08);
        padding: 0;
        min-width: 360px;
        max-width: 480px;
        max-height: 80vh;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        animation: su-pop-in 0.18s cubic-bezier(0.34, 1.56, 0.64, 1);
      }
      @keyframes su-pop-in {
        from { transform: scale(0.92); opacity: 0; }
        to { transform: scale(1); opacity: 1; }
      }
      .su-warn-popup__header {
        background: linear-gradient(135deg, #1e3a5f 0%, #1d4c58 100%);
        color: #fff;
        padding: 16px 20px;
        font-size: 15px;
        font-weight: 600;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .su-warn-popup__close {
        background: rgba(255,255,255,0.15);
        border: none;
        color: #fff;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        cursor: pointer;
        font-size: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.15s;
      }
      .su-warn-popup__close:hover {
        background: rgba(255,255,255,0.3);
      }
      .su-warn-popup__body {
        padding: 16px 20px;
        overflow-y: auto;
        max-height: 60vh;
      }
      .su-warn-section {
        margin-bottom: 14px;
      }
      .su-warn-section:last-child {
        margin-bottom: 0;
      }
      .su-warn-section__title {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.6px;
        color: #64748b;
        margin-bottom: 6px;
      }
      .su-warn-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: 8px;
        font-size: 13px;
        color: #1e293b;
        line-height: 1.4;
      }
      .su-warn-item--error {
        background: #fef2f2;
        border: 1px solid #fecaca;
      }
      .su-warn-item--warning {
        background: #fffbeb;
        border: 1px solid #fde68a;
      }
      .su-warn-item--ok {
        background: #f0fdf4;
        border: 1px solid #bbf7d0;
      }
      .su-warn-item + .su-warn-item {
        margin-top: 4px;
      }
      .su-warn-icon {
        font-size: 14px;
        flex-shrink: 0;
      }
      .su-warn-mr-url {
        color: #196fff;
        text-decoration: none;
        font-weight: 500;
        word-break: break-all;
      }
      .su-warn-mr-url:hover {
        text-decoration: underline;
      }
      .su-warn-assignee-label {
        flex: 1;
        min-width: 0;
        font-weight: 500;
      }
      .su-warn-approvals {
        margin-left: auto;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 10px;
        font-size: 12px;
        white-space: nowrap;
      }
      .su-warn-approvals--ok {
        background: #dcfce7;
        color: #166534;
      }
      .su-warn-approvals--low {
        background: #fee2e2;
        color: #991b1b;
      }
    `
    document.head.appendChild(style)
  }

  function showPopup(taskId, warnings) {
    document.querySelectorAll('.su-warn-overlay').forEach(el => el.remove())

    const overlay = document.createElement('div')
    overlay.className = 'su-warn-overlay'
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove()
    })

    const popup = document.createElement('div')
    popup.className = 'su-warn-popup'

    const header = document.createElement('div')
    header.className = 'su-warn-popup__header'
    header.innerHTML = '<span>' + taskId + ' — Warnings</span>'
    const closeBtn = document.createElement('button')
    closeBtn.className = 'su-warn-popup__close'
    closeBtn.textContent = '✕'
    closeBtn.addEventListener('click', () => overlay.remove())
    header.appendChild(closeBtn)
    popup.appendChild(header)

    const body = document.createElement('div')
    body.className = 'su-warn-popup__body'

    // Changelog section
    const changelogSection = document.createElement('div')
    changelogSection.className = 'su-warn-section'
    const changelogTitle = document.createElement('div')
    changelogTitle.className = 'su-warn-section__title'
    changelogTitle.textContent = 'Changelog'
    changelogSection.appendChild(changelogTitle)
    const changelogItem = document.createElement('div')
    if (warnings.missingChangelog) {
      changelogItem.className = 'su-warn-item su-warn-item--error'
      changelogItem.innerHTML = '<span class="su-warn-icon">❌</span> Missing changelog'
    } else {
      changelogItem.className = 'su-warn-item su-warn-item--ok'
      changelogItem.innerHTML = '<span class="su-warn-icon">✅</span> Changelog present'
    }
    changelogSection.appendChild(changelogItem)
    body.appendChild(changelogSection)

    // MR section
    const mrSection = document.createElement('div')
    mrSection.className = 'su-warn-section'
    const mrTitle = document.createElement('div')
    mrTitle.className = 'su-warn-section__title'
    mrTitle.textContent = 'Merge Requests'
    mrSection.appendChild(mrTitle)

    if (warnings.missingMr) {
      const noMr = document.createElement('div')
      noMr.className = 'su-warn-item su-warn-item--error'
      noMr.innerHTML = '<span class="su-warn-icon">❌</span> No MR linked'
      mrSection.appendChild(noMr)
    } else if (warnings.mrs && warnings.mrs.length > 0) {
      var minMr = typeof warnings.minMrApprovals === 'number' ? warnings.minMrApprovals : 2
      warnings.mrs.forEach(function(mr) {
        const mrItem = document.createElement('div')
        const isUnknown = typeof mr.approvals !== 'number'
        const isLow = !isUnknown && mr.approvals < minMr
        const isOk = !isUnknown && mr.approvals >= minMr
        mrItem.className = 'su-warn-item ' + (isOk ? 'su-warn-item--ok' : isLow ? 'su-warn-item--warning' : 'su-warn-item--error')
        const projectName = mr.mrUrl.split('/-/')[0].split('/').slice(-1)[0] || mr.mrUrl
        const approvalsLabel = isUnknown ? '?' : mr.approvals
        const icon = isOk ? '✅' : isLow ? '⚠️' : '❓'
        mrItem.innerHTML =
          '<span class="su-warn-icon">' + icon + '</span>' +
          '<a href="' + mr.mrUrl + '" target="_blank" class="su-warn-mr-url">' + projectName + ' #' + (mr.mrUrl.match(/merge_requests\/(\d+)/) || ['','?'])[1] + '</a>' +
          '<span class="su-warn-approvals ' + (isOk ? 'su-warn-approvals--ok' : 'su-warn-approvals--low') + '">' +
          approvalsLabel + '/' + minMr + ' approvals</span>'
        mrSection.appendChild(mrItem)
      })
    }
    body.appendChild(mrSection)

    var sesSection = document.createElement('div')
    sesSection.className = 'su-warn-section'
    var sesTitle = document.createElement('div')
    sesTitle.className = 'su-warn-section__title'
    sesTitle.textContent = 'SES assignees'
    sesSection.appendChild(sesTitle)

    if (warnings.requiresCrCheck) {
      var minCr = typeof warnings.minCrAssignees === 'number' ? warnings.minCrAssignees : 2
      var crCount = warnings.crAssigneeCount != null ? warnings.crAssigneeCount : 0
      var crRow = document.createElement('div')
      var crOk = !warnings.lowCrAssignees
      crRow.className = 'su-warn-item ' + (crOk ? 'su-warn-item--ok' : 'su-warn-item--error')
      crRow.innerHTML =
        '<span class="su-warn-icon">' + (crOk ? '✅' : '❌') + '</span>' +
        '<span class="su-warn-assignee-label">Code review assignees</span>' +
        '<span class="su-warn-approvals ' + (crOk ? 'su-warn-approvals--ok' : 'su-warn-approvals--low') + '">' +
        crCount + '/' + minCr + '</span>'
      sesSection.appendChild(crRow)
    }

    if (warnings.requiresCtCheck) {
      var ctMin = 1
      var ctCount = warnings.ctAssigneeCount != null ? warnings.ctAssigneeCount : 0
      var ctRow = document.createElement('div')
      var ctOk = !warnings.missingCtAssignees
      ctRow.className = 'su-warn-item ' + (ctOk ? 'su-warn-item--ok' : 'su-warn-item--error')
      ctRow.innerHTML =
        '<span class="su-warn-icon">' + (ctOk ? '✅' : '❌') + '</span>' +
        '<span class="su-warn-assignee-label">Test assignees</span>' +
        '<span class="su-warn-approvals ' + (ctOk ? 'su-warn-approvals--ok' : 'su-warn-approvals--low') + '">' +
        ctCount + '/' + ctMin + '</span>'
      sesSection.appendChild(ctRow)
    }

    if (warnings.requiresCrCheck || warnings.requiresCtCheck) {
      body.appendChild(sesSection)
    }

    popup.appendChild(body)
    overlay.appendChild(popup)
    document.body.appendChild(overlay)
  }

  // Inject badges on each card
  Object.keys(taskWarnings).forEach(function(taskId) {
    const warnings = taskWarnings[taskId]
    var hasIssue = warnings.missingChangelog || warnings.missingMr || warnings.lowApprovals ||
      warnings.lowCrAssignees || warnings.missingCtAssignees
    if (!hasIssue) return

    const cards = document.querySelectorAll('[data-test-selector="rctCardBase"]')
    cards.forEach(function(card) {
      const linkEl = card.querySelector('.Card__identifier a')
      if (!linkEl) return
      if (linkEl.innerText.trim() !== taskId) return

      const topRight = card.querySelector('.Card__top__right__relative')
      if (!topRight) return
      const parent = topRight.parentElement
      if (!parent) return

      // Remove previous badge on this card
      parent.querySelectorAll('.su-warn-badge').forEach(el => el.remove())

      var minMrForBadge = typeof warnings.minMrApprovals === 'number' ? warnings.minMrApprovals : 2
      const issueCount = (warnings.missingChangelog ? 1 : 0) +
        (warnings.missingMr ? 1 : 0) +
        (warnings.lowApprovals ? warnings.mrs.filter(function(m) {
          return typeof m.approvals !== 'number' || m.approvals < minMrForBadge
        }).length : 0) +
        (warnings.lowCrAssignees ? 1 : 0) +
        (warnings.missingCtAssignees ? 1 : 0)

      const badge = document.createElement('div')
      badge.className = 'su-warn-badge' +
        (warnings.missingChangelog || warnings.missingMr || warnings.lowCrAssignees || warnings.missingCtAssignees ? '' : ' su-warn-badge--yellow')
      badge.textContent = issueCount > 9 ? '9+' : String(issueCount)
      badge.title = 'Click for details'

      badge.addEventListener('click', function(e) {
        e.stopPropagation()
        e.preventDefault()
        showPopup(taskId, warnings)
      })

      parent.insertBefore(badge, topRight)
    })
  })
}

async function scanKanbanBoard() {
  console.log('[soft-utils] scanKanbanBoard: start')
  const config = await getStorageValues([
    'kanbanPageUrl',
    'kanbanWorkspaceId',
    'gitlabToken'
  ])

  if (!config.kanbanPageUrl) {
    console.warn('[soft-utils] scanKanbanBoard: fail — kanbanPageUrl is empty (set it in extension options)')
    return { ok: false, reason: 'no-kanban-url' }
  }

  const [activeTab] = await queryTabs({ active: true, currentWindow: true })
  if (!activeTab || !activeTab.id) {
    console.warn('[soft-utils] scanKanbanBoard: fail — no active tab')
    return { ok: false, reason: 'no-active-tab' }
  }

  console.log('[soft-utils] scanKanbanBoard: tab', activeTab.id, activeTab.url || '(no url)')

  const missingTasks = new Set()
  const missingChangelogTasks = new Set()
  const approvalsByMr = new Map()
  const taskWarnings = {}

  let result
  try {
    result = await executeScript({
      target: { tabId: activeTab.id },
      func: collectKanbanTasks,
      args: [config.kanbanPageUrl, getKanbanLaneConfigForPageScript()]
    })
  } catch (err) {
    console.error(
      '[soft-utils] scanKanbanBoard: fail — cannot inject on this tab (open the Kanban page in this tab, not chrome:// or another extension)',
      err
    )
    return { ok: false, reason: 'inject-collect-failed', error: String(err) }
  }

  const payload = result && result[0] && result[0].result ? result[0].result : {}
  const rawTasks = Array.isArray(payload.tasks) ? payload.tasks : []
  if (payload.reason) {
    console.warn('[soft-utils] scanKanbanBoard: collectKanbanTasks reason:', payload.reason, payload)
  }
  console.log('[soft-utils] scanKanbanBoard: task count', rawTasks.length)

  if (rawTasks.length === 0 && payload.reason === 'url-mismatch') {
    console.warn(
      '[soft-utils] scanKanbanBoard: page URL does not match kanbanPageUrl (options).',
      'tab:',
      activeTab.url,
      'configured:',
      config.kanbanPageUrl,
      'injected page reported:',
      payload.href
    )
  } else if (rawTasks.length === 0 && payload.reason === 'no-cards-in-lanes') {
    console.warn(
      '[soft-utils] scanKanbanBoard: URL ok but no cards in configured lanes (see KANBAN_LANE_CONFIG).',
      'laneHeaderCount:',
      payload.laneHeaderCount,
      'laneBodyCount:',
      payload.laneBodyCount
    )
  }

  if (rawTasks.length > 0) {
    for (const entry of rawTasks) {
      const idtask =
        typeof entry === 'string'
          ? entry
          : entry && typeof entry.taskId === 'string'
            ? entry.taskId
            : ''
      const laneName =
        typeof entry === 'object' && entry && typeof entry.laneName === 'string'
          ? entry.laneName
          : ''
      const laneId =
        typeof entry === 'object' && entry && typeof entry.laneId === 'string'
          ? entry.laneId
          : ''
      if (!idtask) continue

      if (laneId === 'todo' || laneId === 'in_progress') {
        taskWarnings[idtask] = {
          laneName,
          laneId,
          skipAllChecks: true,
          requiresCrCheck: false,
          requiresCtCheck: false,
          minMrApprovals: 2,
          minCrAssignees: 0,
          crAssigneeCount: 0,
          ctAssigneeCount: 0,
          lowCrAssignees: false,
          missingCtAssignees: false,
          missingChangelog: false,
          missingMr: false,
          lowApprovals: false,
          mrs: []
        }
        continue
      }

      const sesOrigin = getSesOriginFromKanbanPageUrl(config.kanbanPageUrl)
      const taskDataText = await fetchTaskData(idtask, config.kanbanWorkspaceId, sesOrigin)
      const attributes = extractTaskAttributes(taskDataText)

      const requiresCrCheck = Boolean(laneId && isLaneAtOrAfter(laneId, 'code_review'))
      const requiresCtCheck = Boolean(laneId && isLaneAtOrAfter(laneId, 'testing'))
      const minMrAppr = minGitlabApprovalsForLane(laneId)
      const minCr = minCrAssigneesForLane(laneId)

      const warnings = {
        laneName,
        laneId,
        requiresCrCheck,
        requiresCtCheck,
        minMrApprovals: minMrAppr,
        minCrAssignees: minCr,
        crAssigneeCount: attributes.crAssigneeCount,
        ctAssigneeCount: attributes.ctAssigneeCount,
        lowCrAssignees: false,
        missingCtAssignees: false,
        missingChangelog: false,
        missingMr: false,
        lowApprovals: false,
        mrs: []
      }

      if (requiresCrCheck && attributes.crAssigneeCount < minCr) {
        warnings.lowCrAssignees = true
      }
      if (requiresCtCheck && attributes.ctAssigneeCount < 1) {
        warnings.missingCtAssignees = true
      }

      if (attributes.mrUrls.length > 0) {
        for (const mrUrl of attributes.mrUrls) {
          let approvals = null
          if (approvalsByMr.has(mrUrl)) {
            approvals = approvalsByMr.get(mrUrl)
          } else {
            approvals = await callGitlabForMr(mrUrl, config.gitlabToken)
            approvalsByMr.set(mrUrl, approvals)
          }
          warnings.mrs.push({ mrUrl, approvals })
          if (typeof approvals !== 'number' || approvals < minMrAppr) {
            warnings.lowApprovals = true
          }
        }
      } else {
        missingTasks.add(idtask)
        warnings.missingMr = true
      }

      const changelogHasValue = attributes.changelogValues.some((value) => {
        if (typeof value !== 'string') return false
        return value.trim().length > 0
      })
      if (!changelogHasValue) {
        missingChangelogTasks.add(idtask)
        warnings.missingChangelog = true
      }

      taskWarnings[idtask] = warnings
    }
  }

  try {
    await executeScript({
      target: { tabId: activeTab.id },
      func: injectWarnings,
      args: [taskWarnings]
    })
  } catch (err) {
    console.error('[soft-utils] scanKanbanBoard: fail — injectWarnings', err)
    return { ok: false, reason: 'inject-warnings-failed', error: String(err) }
  }

  const kanbanTaskDetails = Object.keys(taskWarnings).map((taskId) => {
    const w = taskWarnings[taskId]
    return {
      taskId,
      laneName: typeof w.laneName === 'string' ? w.laneName : '',
      laneId: typeof w.laneId === 'string' ? w.laneId : '',
      skipChecks: Boolean(w.skipAllChecks),
      missingMr: Boolean(w.missingMr),
      missingChangelog: Boolean(w.missingChangelog),
      lowApprovals: Boolean(w.lowApprovals),
      requiresCrCheck: Boolean(w.requiresCrCheck),
      requiresCtCheck: Boolean(w.requiresCtCheck),
      lowCrAssignees: Boolean(w.lowCrAssignees),
      missingCtAssignees: Boolean(w.missingCtAssignees),
      crAssigneeCount: typeof w.crAssigneeCount === 'number' ? w.crAssigneeCount : 0,
      ctAssigneeCount: typeof w.ctAssigneeCount === 'number' ? w.ctAssigneeCount : 0,
      minMrApprovals: typeof w.minMrApprovals === 'number' ? w.minMrApprovals : 2,
      minCrAssignees: typeof w.minCrAssignees === 'number' ? w.minCrAssignees : 0,
      mrs: Array.isArray(w.mrs)
        ? w.mrs.map((m) => ({
            mrUrl: m.mrUrl,
            approvals: typeof m.approvals === 'number' ? m.approvals : null
          }))
        : []
    }
  })

  const intervalData = await getStorageValues(['kanbanIntervalMinutes'])
  const minutes = intervalData.kanbanIntervalMinutes ?? DEFAULTS.kanbanIntervalMinutes
  updateKanbanAlarm(minutes)
  console.log('[soft-utils] scanKanbanBoard: kanbanSync alarm reset (interval', minutes, 'min) — before writing storage')

  await new Promise((resolve, reject) => {
    chrome.storage.sync.set(
      {
        kanbanMissingTasks: Array.from(missingTasks),
        kanbanMissingChangelogTasks: Array.from(missingChangelogTasks),
        kanbanApprovals: Array.from(approvalsByMr.entries()).map(([mrUrl, approvals]) => ({
          mrUrl,
          approvals
        })),
        kanbanTaskDetails,
        kanbanLastRunAt: Date.now()
      },
      () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
          return
        }
        resolve()
      }
    )
  })

  console.log('[soft-utils] scanKanbanBoard: success — storage updated')

  return { ok: true }
}

chrome.runtime.onInstalled.addListener(() => {
  Object.entries(DEFAULTS).forEach(([key, value]) => setDefaultValue(key, value))
  updateKanbanAlarm(DEFAULTS.kanbanIntervalMinutes)
})

chrome.runtime.onStartup.addListener(async () => {
  const data = await getStorageValues(['kanbanIntervalMinutes'])
  updateKanbanAlarm(data.kanbanIntervalMinutes)
})

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return
  if (changes.kanbanIntervalMinutes) {
    updateKanbanAlarm(changes.kanbanIntervalMinutes.newValue)
  }
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'kanbanSync') return
  scanKanbanBoard().catch((err) => {
    console.error('[soft-utils] scanKanbanBoard (alarm):', err)
  })
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'scanKanbanBoard') return false
  scanKanbanBoard()
    .then((result) => {
      sendResponse(result && typeof result === 'object' ? result : { ok: true })
    })
    .catch((err) => {
      console.error('[soft-utils] scanKanbanBoard (message):', err)
      sendResponse({ ok: false, reason: 'exception', error: String(err) })
    })
  return true
})

const DEFAULTS = {
  colorBackground: '#1d4c58',
  colorText: '#ffffff',
  fillCt: '📄',
  kanbanPageUrl: 'https://sesuite.softexpert.com/softexpert/workspace?page=305154,275',
  kanbanIntervalMinutes: 10,
  kanbanWorkspaceId: '310',
  gitlabToken: ''
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
  return new Promise((resolve) => {
    chrome.scripting.executeScript(details, resolve)
  })
}

async function fetchTaskData(idtask, cdworkspace) {
  if (!idtask || !cdworkspace) return ''
  const formData = new URLSearchParams({
    idtask,
    cdworkspace,
    action: '2',
    view: '2'
  })
  const response = await fetch('https://sesuite.softexpert.com/se/task/rest/taskData.php', {
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
  if (!taskDataText) return { mrUrls: [], changelogValues: [] }
  let payload = null
  try {
    payload = JSON.parse(taskDataText)
  } catch (error) {
    return { mrUrls: [], changelogValues: [] }
  }

  const results = payload && payload.results && Array.isArray(payload.results) ? payload.results : []
  const urls = []
  const changelogValues = []

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
    changelogValues
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

function collectKanbanTasks(pageUrl) {
  if (!pageUrl || !window.location.href.startsWith(pageUrl)) return { tasks: [] }
  const laneHeaders = document.querySelectorAll('.LaneHeader')
  const laneBodies = document.querySelectorAll('.LaneBody')

  if (!laneHeaders || laneHeaders.length === 0) return { tasks: [], reason: 'no-lane-headers' }
  if (!laneBodies || laneBodies.length === 0) return { tasks: [], reason: 'no-lane-bodies' }
  
  const tasks = []
  laneHeaders.forEach((header, index) => {
    if (index < 2 || index > 7) return
    const laneBody = laneBodies[index]
    if (!laneBody) return
    const cards = laneBody.querySelectorAll('[data-test-selector="rctCardBase"]')
    
    if (!cards || cards.length === 0) return
    cards.forEach((card) => {
      const span = card.querySelector('.Card__identifier a')
      const idtask = span && span.innerText ? span.innerText.trim() : ''
      if (idtask) tasks.push(idtask)
    })
  })

  return { tasks: Array.from(new Set(tasks)) }
}

async function scanKanbanBoard() {
  const config = await getStorageValues([
    'kanbanPageUrl',
    'kanbanWorkspaceId',
    'gitlabToken'
  ])

  if (!config.kanbanPageUrl) return

  const [activeTab] = await queryTabs({ active: true, currentWindow: true })
  if (!activeTab || !activeTab.id) return

  const missingTasks = new Set()
  const missingChangelogTasks = new Set()
  const approvalsByMr = new Map()

  const result = await executeScript({
    target: { tabId: activeTab.id },
    func: collectKanbanTasks,
    args: [config.kanbanPageUrl]
  })

  const payload = result && result[0] && result[0].result ? result[0].result : {}
  const tasks = payload.tasks ? payload.tasks : []

  if (tasks.length > 0) {
    for (const idtask of tasks) {
      const taskDataText = await fetchTaskData(idtask, config.kanbanWorkspaceId)
      const attributes = extractTaskAttributes(taskDataText)
      if (attributes.mrUrls.length > 0) {
        for (const mrUrl of attributes.mrUrls) {
          if (!approvalsByMr.has(mrUrl)) {
            const approvals = await callGitlabForMr(mrUrl, config.gitlabToken)
            approvalsByMr.set(mrUrl, approvals)
          }
        }
      } else {
        missingTasks.add(idtask)
      }
      const changelogHasValue = attributes.changelogValues.some((value) => {
        if (typeof value !== 'string') return false
        return value.trim().length > 0
      })
      if (!changelogHasValue) {
        missingChangelogTasks.add(idtask)
      }
    }
  }

  chrome.storage.sync.set({
    kanbanMissingTasks: Array.from(missingTasks),
    kanbanMissingChangelogTasks: Array.from(missingChangelogTasks),
    kanbanApprovals: Array.from(approvalsByMr.entries()).map(([mrUrl, approvals]) => ({
      mrUrl,
      approvals
    })),
    kanbanLastRunAt: Date.now()
  })
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
  scanKanbanBoard()
})

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'scanKanbanBoard') return
  scanKanbanBoard()
})

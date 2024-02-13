export function canRunStorage() {
  return typeof chrome !== 'undefined' && typeof chrome.storage !== 'undefined'
}

export async function getCurrentTab() {
  return await chrome.tabs.query({ active: true, currentWindow: true })
}

export function isStartPage(tab) {
  return typeof tab === 'undefined' || typeof tab[0] === 'undefined' || typeof tab[0].url === 'undefined' || tab[0].url.includes('chrome://')
}

export function isOptionsPage(tab) {
  return typeof tab !== 'undefined' && typeof tab[0] !== 'undefined' && typeof tab[0].url !== 'undefined' && tab[0].url.startsWith('chrome-extension://') === true && tab[0].url.endsWith('/options.html') === true
}

export function getCssPropertyValue(propertyName) {
  return getComputedStyle(document.querySelector(':root')).getPropertyValue(propertyName)
}

export function setCssPropertyValue(propertyName, propertyValue) {
  document.querySelector(':root').style.setProperty(propertyName, propertyValue)
}

export function setStorage(value) {
  if (canRunStorage() === false) return
  chrome.storage.sync.set(value)
}

export function getStorage(value) {
  if (canRunStorage() === false) return
  chrome.storage.sync.get(value)
}
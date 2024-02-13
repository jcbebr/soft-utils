function setDefaultColor(colorName, defaultColor) {
  chrome.storage.sync.get(colorName, (data) => {
    if (!data[colorName]) {
      let color = {}
      color[colorName] = defaultColor
      chrome.storage.sync.set(color);
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  setDefaultColor('colorBackground', '#1d4c58');
  setDefaultColor('colorText', '#ffffff');
  setDefaultColor('fillCt', '📄');
});

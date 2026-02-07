import { getStorage, setCssPropertyValue, setStorage } from '../utils.js'

const inputColorBackground = document.getElementById('inputColorBackground');
const inputColorText = document.getElementById('inputColorText');
const inputFillCtSearchFor = document.getElementById('fillCtSearchFor');
const inputKanbanPageUrl = document.getElementById('kanbanPageUrl');
const inputKanbanWorkspaceId = document.getElementById('kanbanWorkspaceId');
const inputKanbanIntervalMinutes = document.getElementById('kanbanIntervalMinutes');
const inputGitlabToken = document.getElementById('gitlabToken');

getStorage((data) => {
  const colorBackground = data.colorBackground || '#1d4c58'
  const colorText = data.colorText || '#ffffff'
  const fillCt = data.fillCt || ''
  const kanbanPageUrl = data.kanbanPageUrl || 'https://sesuite.softexpert.com/softexpert/workspace?page=305154,275'
  const kanbanWorkspaceId = data.kanbanWorkspaceId || '310'
  const kanbanIntervalMinutes = data.kanbanIntervalMinutes || 10
  const gitlabToken = data.gitlabToken || ''

  setCssPropertyValue('--colorBackground', colorBackground)
  setCssPropertyValue('--colorText', colorText)

  inputColorBackground.value = colorBackground
  inputColorText.value = colorText
  inputFillCtSearchFor.value = fillCt
  inputKanbanPageUrl.value = kanbanPageUrl
  inputKanbanWorkspaceId.value = kanbanWorkspaceId
  inputKanbanIntervalMinutes.value = kanbanIntervalMinutes
  inputGitlabToken.value = gitlabToken
});

inputColorBackground.onchange = (event) => {
  const colorBackground = event.target.value;
  setCssPropertyValue('--colorBackground', colorBackground)
  setStorage({ colorBackground });
};

inputColorText.onchange = (event) => {
  const colorText = event.target.value;
  setCssPropertyValue('--colorText', colorText)
  setStorage({ colorText });
};

inputFillCtSearchFor.onchange = (event) => {
  const fillCt = event.target.value;
  setStorage({ fillCt });
};

inputKanbanPageUrl.onchange = (event) => {
  const kanbanPageUrl = event.target.value;
  setStorage({ kanbanPageUrl });
};

inputKanbanWorkspaceId.onchange = (event) => {
  const kanbanWorkspaceId = event.target.value;
  setStorage({ kanbanWorkspaceId });
};

inputKanbanIntervalMinutes.onchange = (event) => {
  const kanbanIntervalMinutes = Math.max(1, Number(event.target.value) || 10);
  inputKanbanIntervalMinutes.value = kanbanIntervalMinutes
  setStorage({ kanbanIntervalMinutes });
};

inputGitlabToken.onchange = (event) => {
  const gitlabToken = event.target.value;
  setStorage({ gitlabToken });
};
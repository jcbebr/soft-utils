import { getStorage, setCssPropertyValue, setStorage } from '../utils.js'

const inputColorBackground = document.getElementById('inputColorBackground');
const inputColorText = document.getElementById('inputColorText');
const inputFillCtSearchFor = document.getElementById('fillCtSearchFor');

getStorage((data) => {
  setCssPropertyValue('--colorBackground', data.colorBackground)
  setCssPropertyValue('--colorText', data.colorText)

  inputColorBackground.value = data.colorBackground
  inputColorText.value = data.colorText
  inputFillCtSearchFor.value = data.fillCt
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
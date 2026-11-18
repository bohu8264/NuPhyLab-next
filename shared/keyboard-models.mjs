import additional from './additional-keyboards.json' with {type:'json'};
// Product identity, RGB addresses and matrix positions are separate contracts.
export const KEYBOARD_MODELS = Object.freeze({
  'air75-v3': Object.freeze({name:'Air75 V3',vendorId:0x19f5,productIds:[0x1028],keyCount:84,sideCount:20,canvasCount:84,rows:6,columns:16,extraKeys:2,qualifiedFirmware:'2.0.0.7',qualifiedFirmwares:Object.freeze(['1.0.23.6','2.0.0.7']),minimumVersion:'1.0.16.6',businessId:'1930212869851615233',globalPalette:false,functionRow:true,unmappedIndices:[83]}),
  kick75: Object.freeze({name:'Kick75',vendorId:0x19f5,productIds:[0x1026,0x1027],keyCount:80,sideCount:5,canvasCount:84,rows:6,columns:15,extraKeys:2,qualifiedFirmware:'4.0.18.6',minimumVersion:'4.0.18.6',businessId:'1930094363885735938',globalPalette:true,functionRow:true,unmappedIndices:[80,81,82,83]}),
  ...Object.fromEntries(Object.entries(additional).map(([id,profile])=>[id,Object.freeze(profile)])),
});
export const KEYBOARD_MODEL_IDS = Object.freeze(Object.keys(KEYBOARD_MODELS));
export const isKeyboardModel = id => typeof id === 'string' && Object.hasOwn(KEYBOARD_MODELS,id);
export function getKeyboardProfile(id='air75-v3') {
  if(!isKeyboardModel(id))throw new Error(`Unsupported keyboard model: ${id}`);
  return KEYBOARD_MODELS[id];
}
export const getCanvasCount = (id='air75-v3') => getKeyboardProfile(id).canvasCount;
// Legacy AIR/Kick artwork keeps 84 slots. Larger layouts use their own size.
export const MAX_CANVAS_COUNT = Math.max(...Object.values(KEYBOARD_MODELS).map(p=>p.canvasCount));
export function canvasCountForLayout(keys) {
  if (!Array.isArray(keys) || keys.some(k=>!Number.isInteger(k.index)||k.index<0||k.index>=MAX_CANVAS_COUNT))
    throw new TypeError('Invalid keyboard LED index');
  return Math.max(84,...keys.map(key=>key.index+1));
}

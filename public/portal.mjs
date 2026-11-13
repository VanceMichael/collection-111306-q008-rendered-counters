let state=await(await fetch('/api/snapshot')).json();
document.querySelector('#insert').onclick=()=>{const section=document.createElement('section');section.innerHTML='<h2>前置检查</h2><p class="rule">核对设备</p>';document.querySelector('#manual').prepend(section);};
if(state.lateStyle)setTimeout(()=>{const style=document.createElement('style');style.textContent='body{counter-reset:chapter 6}';document.head.append(style);},180);
window.portalReady=true;

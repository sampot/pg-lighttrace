export class GameAudio {
  constructor(){this.enabled=false;this.started=false;this.music=new Audio("./music.ogg");this.music.loop=true;this.music.volume=.22;this.fx={click:Object.assign(new Audio("./click.ogg"),{volume:.35}),ok:Object.assign(new Audio("./ok.ogg"),{volume:.42}),hit:Object.assign(new Audio("./hit.ogg"),{volume:.48}),soft:Object.assign(new Audio("./soft.ogg"),{volume:.32}),coin:Object.assign(new Audio("./coin.ogg"),{volume:.4})}}
  async start(){this.started=true;if(!this.enabled)return;try{await this.music.play()}catch{}}
  setEnabled(on){this.enabled=on;if(!on)this.music.pause();else if(this.started)void this.start()}
  play(name){if(!this.enabled||!this.fx[name])return;const a=this.fx[name];a.currentTime=0;void a.play().catch(()=>{})}
}

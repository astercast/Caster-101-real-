import Phaser from 'phaser';

export class BattleScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BattleScene' });
  }

  preload() {
    this.load.spritesheet('enemy', 'assets/enemy.png', { frameWidth: 32, frameHeight: 32 });
  }

  create(data) {
    this.add.rectangle(240, 160, 480, 320, 0x111133, 0.98);
    this.add.text(140, 30, 'Battle!', { font: '20px monospace', fill: '#fff' });
    // Player sprite (left)
    this.playerSprite = this.add.sprite(120, 180, 'player', 0).setScale(1.2);
    // Enemy sprite (right, animated)
    this.anims.create({
      key: 'enemyMove',
      frames: this.anims.generateFrameNumbers('enemy', { start: 0, end: 3 }),
      frameRate: 6,
      repeat: -1
    });
    this.enemySprite = this.add.sprite(360, 180, 'enemy', 0).setScale(1.2);
    this.enemySprite.play('enemyMove');
    // Simple attack button
    this.attackBtn = this.add.text(200, 260, '[ Attack ]', { font: '18px monospace', fill: '#ff0', backgroundColor: '#333', padding: { x: 10, y: 4 } })
      .setInteractive()
      .on('pointerdown', () => this.handleAttack());
    this.playerHP = 10;
    this.enemyHP = 8;
    this.statusText = this.add.text(160, 100, `You: ${this.playerHP}  Enemy: ${this.enemyHP}`, { font: '16px monospace', fill: '#fff' });
  }

  handleAttack() {
    this.enemyHP -= Math.floor(Math.random() * 3) + 1;
    this.statusText.setText(`You: ${this.playerHP}  Enemy: ${this.enemyHP}`);
    if (this.enemyHP <= 0) {
      this.statusText.setText('Victory!');
      this.time.delayedCall(1200, () => this.scene.stop('BattleScene'));
      return;
    }
    // Enemy attacks back
    this.playerHP -= Math.floor(Math.random() * 2) + 1;
    this.statusText.setText(`You: ${this.playerHP}  Enemy: ${this.enemyHP}`);
    if (this.playerHP <= 0) {
      this.statusText.setText('Defeat...');
      this.time.delayedCall(1200, () => this.scene.stop('BattleScene'));
    }
  }
}

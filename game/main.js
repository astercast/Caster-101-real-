import Phaser from 'phaser';
import { fetchNormieStats } from './normie-api';
import { PlayerSprite } from './player-sprite';
import { BattleScene } from './battle.js';

const config = {
  type: Phaser.AUTO,
  width: 480,
  height: 320,
  parent: 'game-container',
  pixelArt: true,
  scene: {
    preload,
    create,
    update
  }
};

let player;
let cursors;
let enemies = [];

async function preload() {
  // Load player sprite sheet (replace with Normies palette sprite sheet if available)
  this.load.spritesheet('player', 'assets/player.png', { frameWidth: 32, frameHeight: 32 });
  this.load.spritesheet('enemy', 'assets/enemy.png', { frameWidth: 32, frameHeight: 32 });
}

async function create() {
  // Fetch normie stats for demo (replace with actual party selection logic)
  const normieId = '1'; // Example normie ID
  const stats = await fetchNormieStats(normieId);

  // HUD panel background
  const hudBg = this.add.rectangle(0, 0, 480, 40, 0x222222, 0.85).setOrigin(0, 0).setDepth(10);
  // HUD text for stats and quest info
  this.hudText = this.add.text(12, 10, `Normie HP: ${stats.hp} | Quest: None`, { font: '16px monospace', fill: '#fff' }).setDepth(11);

  // Player sprite with animation
  this.anims.create({
    key: 'walk',
    frames: this.anims.generateFrameNumbers('player', { start: 0, end: 3 }),
    frameRate: 8,
    repeat: -1
  });
  player = this.add.sprite(240, 160, 'player', 0);
  player.play('walk');
  cursors = this.input.keyboard.createCursorKeys();

  // Animated moving enemies
  this.anims.create({
    key: 'enemyMove',
    frames: this.anims.generateFrameNumbers('enemy', { start: 0, end: 3 }),
    frameRate: 6,
    repeat: -1
  });
  enemies = [];
  for (let i = 0; i < 3; i++) {
    const ex = 80 + i * 120;
    const ey = 100 + (i % 2) * 60;
    const enemy = this.add.sprite(ex, ey, 'enemy', 0);
    enemy.play('enemyMove');
    enemy.direction = Math.random() > 0.5 ? 1 : -1;
    enemies.push(enemy);
  }

  // Store quest state for future logic
  this.quest = { active: false, name: '', progress: 0 };

  // Add battle scene to game
  if (!this.scene.get('BattleScene')) {
    this.scene.add('BattleScene', BattleScene, false);
  }
}

function update() {
  if (!player || !cursors) return;
  let speed = 2;
  let moving = false;
  if (cursors.left.isDown) { player.x -= speed; moving = true; }
  else if (cursors.right.isDown) { player.x += speed; moving = true; }
  if (cursors.up.isDown) { player.y -= speed; moving = true; }
  else if (cursors.down.isDown) { player.y += speed; moving = true; }

  if (moving) {
    if (!player.anims.isPlaying) player.play('walk');
  } else {
    player.anims.stop();
    player.setFrame(0); // Idle frame
  }

  // Move enemies back and forth
  for (const enemy of enemies) {
    enemy.x += 1.2 * enemy.direction;
    // Bounce at screen edges
    if (enemy.x < 40 || enemy.x > 440) enemy.direction *= -1;
    // Collision with player triggers battle
    if (Phaser.Math.Distance.Between(player.x, player.y, enemy.x, enemy.y) < 28) {
      this.scene.pause();
      this.scene.launch('BattleScene');
    }
  }

  // Update HUD with quest info (placeholder)
  if (this.hudText) {
    const quest = this.quest && this.quest.active ? this.quest.name + ' (' + this.quest.progress + '%)' : 'None';
    this.hudText.setText(`Normie HP: 10 | Quest: ${quest}`);
  }
}

new Phaser.Game(config);

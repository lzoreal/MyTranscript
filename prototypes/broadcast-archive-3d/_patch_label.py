import io, re, sys

path = r"D:\MyTranscript\prototypes\broadcast-archive-3d\index.html"
src = io.open(path, encoding="utf-8").read()

start = src.index("function makeLabelTexture(show, index, coverImg) {")
end = src.index("const archiveGroups = [];", start)
old = src[start:end]

new = r'''function makeLabelTexture(show, index, coverImg) {
  // 一张贴在盒面的纸质节目单：米色纸、深棕油墨、左侧一道节目色条
  const W = 1180, H = 420;
  const [c, g] = canvas2d(W, H);

  g.fillStyle = '#e2d5b7'; g.fillRect(0, 0, W, H);
  const grad = g.createLinearGradient(0, 0, W * 0.7, H);
  grad.addColorStop(0, 'rgba(255,250,232,.42)');
  grad.addColorStop(0.55, 'rgba(255,246,226,.06)');
  grad.addColorStop(1, 'rgba(74,52,32,.20)');
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  grain(g, W, H, 9);

  const ink = '#241a12';
  const inkSoft = 'rgba(46,32,22,.72)';
  const rule = 'rgba(52,36,24,.26)';

  // 纸边：外圈压一道浅阴影，标签才像压进盒里
  g.strokeStyle = 'rgba(52,34,20,.45)'; g.lineWidth = 3; g.strokeRect(4, 4, W - 8, H - 8);
  g.strokeStyle = 'rgba(255,252,240,.55)'; g.lineWidth = 1.5; g.strokeRect(9, 9, W - 18, H - 18);

  // 左侧节目色条
  g.fillStyle = show.color; g.fillRect(14, 14, 16, H - 28);
  g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(30, 14, 3, H - 28);

  const left = 60;

  g.fillStyle = inkSoft;
  g.font = '600 16px "Segoe UI",Arial,sans-serif';
  g.fillText('PODCAST ARCHIVE  ·  PROGRAM FILE', left, 56);
  g.textAlign = 'right';
  g.fillText('REC. ' + String(index + 1).padStart(3, '0'), 748, 56);
  g.textAlign = 'left';

  g.strokeStyle = rule; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(left, 74); g.lineTo(748, 74); g.stroke();

  let title = show.name;
  let size = 54;
  g.font = `700 ${size}px Georgia,"Times New Roman",serif`;
  while (g.measureText(title).width > 690 && size > 24) {
    size -= 2;
    g.font = `700 ${size}px Georgia,"Times New Roman",serif`;
  }
  g.fillStyle = ink;
  g.fillText(title, left, 136);

  g.fillStyle = show.color;
  g.font = '600 17px "Segoe UI",Arial,sans-serif';
  g.fillText(((show.categories || []).join('  ·  ') || 'PODCAST').toUpperCase(), left, 172);

  g.fillStyle = inkSoft;
  g.font = '17px "Segoe UI",Arial,sans-serif';
  g.fillText(show.episodeCount + ' EPISODES    ·    ' + show.transcriptCount + ' TRANSCRIPTS', left, 202);

  g.strokeStyle = rule; g.lineWidth = 1;
  g.beginPath(); g.moveTo(left, 226); g.lineTo(748, 226); g.stroke();

  g.fillStyle = inkSoft;
  g.font = 'italic 17px Georgia,serif';
  const latest = (show.episodes[0] && show.episodes[0].title) || '';
  g.fillText('LATEST / ' + latest.slice(0, 52), left, 258);
  g.fillStyle = 'rgba(46,32,22,.5)';
  g.font = '15px "Segoe UI",Arial,sans-serif';
  g.fillText('UPDATED ' + (show.latestAt || '') + '    ·    MYTRANSCRIPT · BILINGUAL ARCHIVE', left, 288);

  // 右下角一枚小印章
  g.strokeStyle = 'rgba(150,58,40,.55)'; g.lineWidth = 2;
  g.strokeRect(left, 322, 158, 34);
  g.fillStyle = 'rgba(150,58,40,.6)';
  g.font = '600 15px "Segoe UI",Arial,sans-serif';
  g.fillText('ARCHIVED COPY', left + 14, 345);

  // 右侧：封面照片 + 两枚磁带盘
  const cw = 190, cx0 = W - cw - 46, cy0 = 52;
  g.fillStyle = 'rgba(40,26,16,.28)';
  g.fillRect(cx0 + 5, cy0 + 6, cw, cw);
  if (coverImg) g.drawImage(coverImg, cx0, cy0, cw, cw);
  else { g.fillStyle = '#c9b尖端'; g.fillStyle = 'rgba(60,44,30,.5)'; g.fillRect(cx0, cy0, cw, cw); }
  g.strokeStyle = 'rgba(40,26,16,.6)'; g.lineWidth = 3; g.strokeRect(cx0, cy0, cw, cw);
  g.strokeStyle = 'rgba(255,250,236,.45)'; g.lineWidth = 1; g.strokeRect(cx0 + 3, cy0 + 3, cw - 6, cw - 6);

  for (const rx of [-0.2, 0.2]) {
    const px = cx0 + cw / 2 + rx * cw, py = cy0 + cw + 44;
    g.strokeStyle = 'rgba(40,26,16,.5)'; g.lineWidth = 2.5;
    g.beginPath(); g.arc(px, py, 22, 0, Math.PI * 2); g.stroke();
    g.fillStyle = show.color;
    g.beginPath(); g.arc(px, py, 8, 0, Math.PI * 2); g.fill();
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = MAX_ANISO;
  return t;
}

'''
# 修掉上面手写时混进来的异常片段
new = new.replace("  else { g.fillStyle = '#c9b尖端'; g.fillStyle = 'rgba(60,44,30,.5)'; g.fillRect(cx0, cy0, cw, cw); }",
                  "  else { g.fillStyle = 'rgba(60,44,30,.5)'; g.fillRect(cx0, cy0, cw, cw); }")

src = src[:start] + new + src[end:]
io.open(path, "w", encoding="utf-8", newline="").write(src)
print("patched", len(old), "->", len(new))

// 头像提取与感知哈希（浏览器端）：边框自动定位 + 面部裁切 + dHash
// 结算图布局：左右两队各 5 行，头像框贴两侧边缘；行中心 Y 比例稳定，X 随分辨率漂移故需检测
const ROWS_Y = [0.478, 0.594, 0.712, 0.829, 0.946];
const AV_W = 0.055, AV_H = 0.100;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取图片')); };
    img.src = url;
  });
}

// 在指定 Y 行从一侧扫描"亮且饱和"的边框列（洋红/金/蓝框 vs 暗色背景）
function findBoxX(pixels, W, y, fromLeft) {
  const at = x => {
    const o = (y * W + x) * 4;
    const r = pixels[o], g = pixels[o + 1], b = pixels[o + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return mx - mn > 55 && mx > 90;
  };
  if (fromLeft) {
    for (let x = 2; x < W * 0.16; x++) if (at(x) && at(x + 1) && at(x + 2)) return x - 1;
  } else {
    for (let x = W - 3; x > W * 0.84; x--) if (at(x) && at(x - 1) && at(x - 2)) return x + 1; // 框右缘
  }
  return null;
}

// 17x16 灰度 dHash → 64 位十六进制（256bit）
function dHashHex(sourceCanvas, sx, sy, sw, sh) {
  const c = document.createElement('canvas');
  c.width = 17; c.height = 16;
  const ctx = c.getContext('2d');
  ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, 17, 16);
  const d = ctx.getImageData(0, 0, 17, 16).data;
  const gray = [];
  for (let i = 0; i < 17 * 16; i++) gray.push(d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114);
  let hex = '';
  let nibble = 0, count = 0;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    nibble = (nibble << 1) | (gray[y * 17 + x] > gray[y * 17 + x + 1] ? 1 : 0);
    if (++count === 4) { hex += nibble.toString(16); nibble = 0; count = 0; }
  }
  return hex;
}

// 从一张结算截图提取 10 个头像（左队 5 + 右队 5，按行序），返回 { phash, crop } 数组
// 提取失败（如布局异常）返回空数组，调用方静默跳过
export async function extractAvatars(file) {
  const img = await loadImage(file);
  // 分析用画布限宽 1200，坐标按比例换算回原图
  const scale = Math.min(1, 1200 / img.naturalWidth);
  const W = Math.round(img.naturalWidth * scale), H = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);
  let pixels;
  try { pixels = ctx.getImageData(0, 0, W, H).data; } catch { return []; }
  const out = [];
  for (const side of ['L', 'R']) {
    for (let row = 0; row < 5; row++) {
      const cy = Math.round(ROWS_Y[row] * H);
      const bx = findBoxX(pixels, W, cy, side === 'L');
      if (bx == null) return []; // 布局异常：整图放弃，不影响入库
      const left = side === 'L' ? bx : bx - Math.round(AV_W * W);
      const top = Math.round((ROWS_Y[row] - AV_H / 2) * H);
      const bw = Math.round(AV_W * W), bh = Math.round(AV_H * H);
      if (left < 0 || top < 0 || left + bw > W || top + bh > H) return [];
      // 框内面部区：左队角标在左上、右队在右上，避开
      const fx = side === 'L' ? left + Math.round(bw * 0.24) : left + Math.round(bw * 0.16);
      const fw = Math.round(bw * 0.60), ft = top + Math.round(bh * 0.26), fh = Math.round(bh * 0.70);
      const phash = dHashHex(canvas, fx, ft, fw, fh);
      // 待标注用小图（96px，jpeg 0.72）
      const thumb = document.createElement('canvas');
      thumb.width = 96; thumb.height = Math.round(96 * fh / fw);
      thumb.getContext('2d').drawImage(canvas, fx, ft, fw, fh, 0, 0, thumb.width, thumb.height);
      out.push({ phash, crop: thumb.toDataURL('image/jpeg', 0.72) });
    }
  }
  return out.length === 10 ? out : [];
}

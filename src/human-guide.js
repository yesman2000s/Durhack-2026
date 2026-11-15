// Draw an illustrative body around the guide joints. All widths follow the
// model's leg length, so the silhouette scales with the person and the crop.
const length = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const mix = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

function limb(ctx, from, to, startRadius, endRadius) {
  const distance = length(from, to);
  if (distance < .01) return;
  const dx = (to.x - from.x) / distance;
  const dy = (to.y - from.y) / distance;
  const nx = -dy, ny = dx;
  ctx.moveTo(from.x + nx * startRadius, from.y + ny * startRadius);
  ctx.lineTo(to.x + nx * endRadius, to.y + ny * endRadius);
  ctx.quadraticCurveTo(to.x + dx * endRadius * 1.5, to.y + dy * endRadius * 1.5,
    to.x - nx * endRadius, to.y - ny * endRadius);
  ctx.lineTo(from.x - nx * startRadius, from.y - ny * startRadius);
  ctx.quadraticCurveTo(from.x - dx * startRadius * 1.5, from.y - dy * startRadius * 1.5,
    from.x + nx * startRadius, from.y + ny * startRadius);
  ctx.closePath();
}

function torso(ctx, shoulder, hip, unit) {
  const distance = length(shoulder, hip);
  const nx = -(hip.y - shoulder.y) / distance;
  const ny = (hip.x - shoulder.x) / distance;
  const at = (t, radius) => {
    const center = mix(shoulder, hip, t);
    return [center.x + nx * radius * unit, center.y + ny * radius * unit];
  };
  ctx.moveTo(...at(-.04, .105));
  ctx.bezierCurveTo(...at(.24, .15), ...at(.57, .095), ...at(.80, .12));
  ctx.quadraticCurveTo(...at(1.16, .14), ...at(1.12, 0));
  ctx.quadraticCurveTo(...at(1.16, -.14), ...at(.80, -.12));
  ctx.bezierCurveTo(...at(.57, -.08), ...at(.24, -.14), ...at(-.04, -.105));
  ctx.quadraticCurveTo(...at(-.13, 0), ...at(-.04, .105));
  ctx.closePath();
}

export function drawHumanGuide(ctx, points, exercise, variant) {
  const unit = length(points[23], points[25]) + length(points[25], points[27]);
  if (!(unit > 0)) return;
  ctx.save();
  ctx.setLineDash([]);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, unit * .008);

  function limbs(offset) {
    const at = (index) => points[index + offset];
    limb(ctx, at(23), at(25), unit * .089, unit * .057);
    limb(ctx, at(25), at(27), unit * .060, unit * .031);
    limb(ctx, at(27), mix(at(29), at(31), .3), unit * .031, unit * .037);
    limb(ctx, at(29), at(31), unit * .040, unit * .029);
    limb(ctx, at(11), at(13), unit * .055, unit * .038);
    limb(ctx, at(13), at(15), unit * .038, unit * .026);
    const hand = exercise === 'push-up' ? at(19) : mix(at(13), at(15), 1.16);
    limb(ctx, at(15), hand, unit * .027, unit * .031);
  }

  // The further limbs remain visible when a knee lifts or the arms separate.
  ctx.beginPath();
  limbs(1);
  ctx.fillStyle = 'rgba(255, 205, 123, .12)';
  ctx.strokeStyle = 'rgba(255, 221, 148, .48)';
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  torso(ctx, points[11], points[23], unit);
  limb(ctx, points[11], points[7], unit * .048, unit * .043);
  limbs(0);
  const head = mix(points[7], points[0], .20);
  const tilt = Math.atan2(points[7].y - points[11].y, points[7].x - points[11].x) + Math.PI / 2;
  ctx.moveTo(head.x + unit * .096 * Math.cos(tilt), head.y + unit * .096 * Math.sin(tilt));
  ctx.ellipse(head.x, head.y, unit * .096, unit * .122, tilt, 0, Math.PI * 2, true);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255, 213, 140, .22)';
  ctx.strokeStyle = '#ffdd94';
  ctx.fill();
  ctx.stroke();

  // Small joint rings keep bends readable without turning the guide into bones.
  ctx.fillStyle = 'rgba(255, 230, 180, .7)';
  for (const index of [13, 23, 25, 27]) {
    const joint = points[index];
    ctx.beginPath();
    ctx.arc(joint.x, joint.y, unit * .014, 0, Math.PI * 2);
    ctx.fill();
  }

  if (exercise === 'squat' && variant === 'barbell') {
    const shoulder = points[11];
    const direction = Math.sign(points[0].x - points[7].x) || 1;
    const x = shoulder.x - direction * unit * .20;
    const y = shoulder.y + unit * .015;
    ctx.beginPath();
    ctx.moveTo(shoulder.x, shoulder.y);
    ctx.lineTo(x, y);
    ctx.lineWidth = unit * .024;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(x, y, unit * .105, unit * .14, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(45, 34, 20, .65)';
    ctx.lineWidth = Math.max(1, unit * .012);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, unit * .025, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

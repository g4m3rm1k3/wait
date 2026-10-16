/** Pure teaching text for the walkthrough. All values come from its live plan. */
import { DEFAULT_SETTINGS, stretchTiming, vPieces } from './planner.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const fmt = value => value === Infinity ? '∞' : value === null || value === undefined ? 'not recorded' : Number.isFinite(value) ? String(Number(value.toFixed(6))) : String(value);
const code = value => `<code>${esc(value)}</code>`;
const seconds = value => `${code(fmt(value))} seconds`;
const array = values => `[${values.map(fmt).join(', ')}]`;
const sum = values => values.reduce((total, value) => total + value, 0);
const cell = (table, row, column, fallback = Infinity) => table?.[row]?.[column] ?? fallback;

function inputData(result, settings) {
  const options = { ...DEFAULT_SETTINGS, ...settings };
  const v = result?.v ?? [];
  const h = result?.h ?? [];
  const stretches = result?.stretches ?? [];
  const shifted = vPieces(v, options);
  return { options, v, h, stretches, n: v.length, S: stretches.length, ...shifted };
}

function pieceTable(data) {
  if (!data.n) return '<p>There are no <code>_2V</code> operation records in this input. Therefore <code>n = 0</code>, <code>V = []</code>, <code>piece = []</code>, and <code>pre = 0</code>. Empty V groups still answer each B event.</p>';
  return `<div class="explanation-table"><table><thead><tr><th>V record from Section 0</th><th>Parsed fields</th><th>Mastercam + margin = operation time</th><th>Remove own tool change</th><th>Add next tool change</th><th>Piece</th></tr></thead><tbody>${data.v.map((op, index) => {
    const raw = op.seconds - data.options.SAFETY_SECONDS;
    const own = data.tcs[index];
    const next = data.tcs[index + 1] ?? 0;
    const reason = index > 0 && op.tool === data.v[index - 1].tool ? 'same tool as previous V op' : 'first V tool / changed tool';
    return `<tr><td>${code(`V${index + 1}: ${op.text}`)}</td><td>${esc(`offset ${op.offset}, rotation ${op.rotation}, tool T${op.tool}`)}</td><td>${code(`${fmt(raw)} + ${fmt(data.options.SAFETY_SECONDS)} = ${fmt(op.seconds)} s`)}</td><td>${code(`${fmt(own)} s`)} (${esc(reason)})</td><td>${code(`${fmt(next)} s`)}${index === data.n - 1 ? ' (no next op)' : ''}</td><td>${code(`p${index + 1} = ${fmt(op.seconds)} − ${fmt(own)} + ${fmt(next)} = ${fmt(data.pieces[index])} s`)}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

/** Provenance display for Section 0 or the first pseudocode line. */
export function explainInput(result, settings = DEFAULT_SETTINGS) {
  const data = inputData(result, settings);
  return `<div class="input-provenance"><p><strong>Where V comes from</strong></p><p>Read the FAM operation list in Section 0. Keep its ${data.n} ${code('_2V')} lines in their existing order to form ${code('V')}; the ${data.h.length} ${code('_2H')} lines form H separately. Each V entry is a complete parsed operation record, including its original line, offset, rotation digit, tool number, and time. V is not a list of guessed durations. For example, ${code('21010')} means offset 2, rotation digit 1, tool 010. V’s rotation digit is retained in the record but does not restrict placement because V calculates the current B angle.</p><p>${code('minutes × 60 + seconds')} is the Mastercam backplot time, which already includes tool change. Add the current ${code(`SAFETY_SECONDS = ${fmt(data.options.SAFETY_SECONDS)}`)} once per operation. The current raw V times are ${code(array(data.v.map(op => op.seconds - data.options.SAFETY_SECONDS)))} seconds; adjusted V operation times are ${code(array(data.v.map(op => op.seconds)))} seconds. These operation times and the shifted pieces below are different quantities.</p>${pieceTable(data)}</div>`;
}

function panel(purpose, names, live, physical) {
  return `<div class="algorithm-line-explanation"><p>${purpose}</p><p><strong>What each name means</strong><br>${names}</p><div><strong>With this input / current step</strong>${live}</div><p><strong>On the machine</strong><br>${physical}</p></div>`;
}

function candidate(result, data, context, lineNumber) {
  const recorded = context.step ?? (lineNumber === 6 ? result.plan.steps.find(step => step.kind === 'skip') : null)
    ?? result.plan.steps.find(step => step.kind === 'try' && step.j > step.i)
    ?? result.plan.steps.find(step => step.kind === 'try') ?? { s: 1, j: 0, i: 0 };
  const s = recorded.s;
  const j = recorded.j;
  const i = recorded.i;
  const stretch = data.stretches[s - 1];
  const values = data.pieces.slice(i, j);
  const W = recorded.w ?? sum(values);
  const cost = recorded.cost ?? stretchTiming(s - 1, stretch, W, data.pre)[1];
  const previous = recorded.kind === 'skip' ? Infinity : recorded.total !== undefined ? recorded.total - cost : cell(context.best ?? result.plan.best, s - 1, i);
  const before = recorded.before ?? cell(context.best ?? result.plan.best, s, j);
  const total = recorded.total ?? previous + cost;
  return { ...recorded, s, j, i, stretch, values, W, cost, previous, before, total,
    better: recorded.better ?? total < before,
    selected: Boolean(context.step),
    label: context.step ? 'The selected replay step' : 'A real example candidate from this input (no replay step was selected)',
    group: i === j ? 'an empty group' : `pieces p${i + 1} through p${j}`,
  };
}

function costExample(data, current) {
  const H = current.stretch.seconds;
  const lockout = current.stretch.lockout;
  if (current.s === 1 && !current.stretch.event) return `${code(`max(${fmt(H)}, ${fmt(data.pre)} + ${fmt(current.W)}) = ${fmt(current.cost)} s`)}. B starts in position, so H starts immediately; only V has its initial tool change before cutting.`;
  const lead = current.s === 1 ? data.pre : 0;
  return `${code(`${fmt(lead)} + max(${fmt(H)}, ${fmt(lockout)} + ${fmt(current.W)}) = ${fmt(current.cost)} s`)}. The leading ${fmt(lead)} seconds is ${current.s === 1 ? 'the first V tool change before the first B event' : 'zero because the first V tool change was already counted'}.`;
}

/**
 * Explain one of the walkthrough's 14 displayed pseudocode lines.
 * context.step is an actual plan.steps entry; best/from may be replay tables.
 * context.walkStretch is a one-based stretch number during backtracking.
 */
export function algorithmLineExplanation(lineNumber, result, settings = DEFAULT_SETTINGS, context = {}) {
  if (!result?.plan || !result.stretches?.length) return '<p>Run a valid Section 0 operation list before exploring this line.</p>';
  const data = inputData(result, settings);
  const current = candidate(result, data, context, lineNumber);
  const { s, j, i } = current;
  const counts = `<p>${esc(current.label)} uses ${code(`s = ${s}, j = ${j}, i = ${i}`)}: ${s - 1} H stretches and ${i} V pieces were completed before this stretch; after it, ${s} H stretches and ${j} V pieces will be completed. It assigns ${esc(current.group)}, containing ${j - i} V operation${j - i === 1 ? '' : 's'}.</p>`;
  const source = code(`best[${s - 1}][${i}]`);
  const destination = code(`best[${s}][${j}]`);

  switch (Number(lineNumber)) {
    case 1:
      return panel('Prepare the ordered vertical operations and separate their tool-change timing before trying any placement.',
        `${code('V')} is the ordered collection of parsed ${code('_2V')} records from Section 0. ${code('n')} counts those records. ${code('v_pieces(V)')} returns ${code('pre')}, the first V tool change, and ${code('piece[1..n]')}, one timed piece per V operation. Each piece contains its own adjusted time minus its own tool change plus the next operation’s tool change. The final piece adds zero because there is no next operation. A repeated tool has zero new tool-change time.`,
        `<p>${code(`n = ${data.n}`)}, ${code(`pre = ${fmt(data.pre)} s`)}, own-tool-change times ${code(array(data.tcs))}, and ${code(`piece = ${array(data.pieces)} s`)}. The first tool change is ${data.n ? code(`min(${fmt(data.options.V_TOOL_CHANGE_SECONDS)}, ${fmt(data.v[0].seconds)}) = ${fmt(data.pre)} s`) : 'zero because V has no operations'}. As a check, ${code(`pre + sum(piece) = ${fmt(data.pre)} + ${fmt(sum(data.pieces))} = ${fmt(sum(data.v.map(op => op.seconds)))} s`)}.</p>${explainInput(result, settings)}`,
        'V changes tools before its wait. Moving that time onto the preceding piece makes it happen while H is still working, and prevents counting the same tool change twice. This changes the timing representation; it preserves V’s operation order.');
    case 2:
      return panel('Create the table of elapsed cycle times, beginning with the one starting situation that is already possible.',
        `${code('best')} is a table. Row ${code('s')} counts completed H stretches; column ${code('j')} counts completed V pieces. A cell stores the shortest elapsed cycle time found for exactly those counts. ${code('0')} means no elapsed time; ${code('∞')} means that situation has not been reached. It is not an infinitely long machine wait.`,
        `<p>This input has ${code(`S = ${data.S}`)} H stretches and ${code(`n = ${data.n}`)} V pieces, so the table has ${data.S + 1} rows and ${data.n + 1} columns, including row and column zero. At initialization ${code('best[0][0] = 0')}; every other cell is ${code('∞')}. Even ${code('best[1][0]')} must be calculated: H can work while V finishes zero pieces.</p>`,
        'Neither spindle has done anything at the starting cell. Later cells will include both simultaneous work and required waiting, measured from the same cycle start.');
    case 3:
      return panel('Consider the H stretches one at a time, in the order the horizontal spindle will run them.',
        `${code('S')} is the total number of H stretches, currently ${data.S}; ${code('s')} is the number of the stretch being considered, from 1 through S. A stretch groups consecutive H operations with one tool and B position. H tool or rotation changes create new stretches; the first can also start with a B event according to ${code('START_IS_B_EVENT')}.`,
        `${counts}<p>Stretch ${s} contains ${current.stretch.ops.map(op => code(op.text)).join('; ')}. Its adjusted H time is ${seconds(current.stretch.seconds)}, and its V lockout is ${seconds(current.stretch.lockout)}. The displayed pseudocode calls it stretch ${s}; JavaScript stores it at array index ${s - 1}.</p>`,
        'H’s cutting order stays fixed. The search decides how much V work fits alongside each H stretch; it does not exchange H operations or split their toolpaths.');
    case 4:
      return panel('For this H stretch, try every possible total amount of V work completed by its end.',
        `${code('j')} is a count of V pieces completed after stretch s, ranging from 0 through ${code(`n = ${data.n}`)}. It is a count, not an operation number or elapsed time. For example, j = 2 means the first two V pieces are finished. ${code('best[s][j]')} describes that exact pair of completed counts.`,
        `${counts}<p>The current destination is ${destination}. Its column ${j} means ${j === 0 ? 'no V pieces completed in total, including earlier stretches' : `pieces p1 through p${j} completed in total, including earlier stretches`}. This line chooses the destination count; the next line tests where this stretch’s own group begins.</p>`,
        'Some stretches may contain no V cutting. Keeping column zero and empty groups allows V to wait through a B event without inventing a vertical operation.');
    case 5:
      return panel('Try each possible boundary between V work already finished and V work assigned to this stretch.',
        `${code('i')} counts V pieces completed before stretch s. It ranges from 0 to j, because V cannot have completed more pieces before the stretch than afterward. The preceding table cell is ${code('best[s−1][i]')}; the new group contains pieces ${code('i+1 … j')}. ${code('j−i')} is the number assigned here.`,
        `${counts}<p>The boundary ${code(`i = ${i}`)} uses ${source} as its starting situation. The group is ${esc(current.group)}. In zero-based JavaScript array terms this is ${code(`V.slice(${i}, ${j})`)}: the first argument is included and the second is excluded. If i equals j, that slice is empty.</p>`,
        'The planner only moves a boundary through V’s existing sequence. It never swaps vertical operations, so a later operation cannot overtake an earlier one.');
    case 6:
      return panel('Discard a candidate when its required earlier situation cannot be reached.',
        `${code('best[s−1][i]')} is the shortest known elapsed time after s−1 H stretches and i V pieces. ${code('∞')} means no valid earlier allocation reaches those counts. ${code('next i')} means skip this boundary and try the next i in the loop. It does not issue a wait or skip a toolpath on the controller.`,
        `${counts}<p>${source} is ${seconds(current.previous)}. ${current.previous === Infinity ? `This candidate is skipped: there is no earlier plan to extend. Lines 7–11 do not run for this candidate.` : `This candidate is reachable, so the condition is false and lines 7–11 can calculate its V group and time.`} Initially, row zero can contain only zero completed V pieces; another row-zero column cannot be used as a starting plan.</p>`,
        'Impossible combinations are removed from the planning calculation. The remaining candidates still respect both channel orders and the B lockout.');
    case 7:
      return panel('Add the timed V pieces assigned to this particular H stretch.',
        `${code('W')} is the group’s duration in seconds. ${code('piece[k]')} is a shifted timing piece from line 1, rather than the original raw Mastercam time. The displayed pieces are numbered p1 through pn; i and j remain counts. Summing ${code('piece[i+1] … piece[j]')} includes the piece at j, and the sum of an empty group is zero.`,
        `${counts}<p>${code(`W = ${current.values.length ? current.values.map(fmt).join(' + ') : '0 (empty sum)'} = ${fmt(current.W)} s`)}. ${current.kind === 'skip' ? 'This sum illustrates the selected boundary, but the unreachable predecessor means the replay skips this line.' : `This is the V work used by the cost calculation for stretch ${s}.`} Tool-change time already shifted into these pieces must not be added again.</p>`,
        'W covers the ordered V work between two handshakes, including the next tool change when line 1 assigned it to this piece. It can overlap H work after the B lockout.');
    case 8:
      return panel('Calculate how long this H stretch takes when it shares the cycle with the proposed V group.',
        `${code('cost')} is this stretch’s added elapsed time, not the full cycle. ${code('H')} is its adjusted horizontal duration, ${code('lockout')} is the time V must stay blocked through the B sequence, and W is the V group time. ${code('max(a,b)')} chooses the longer concurrent branch. ${code('pre')} is the first V tool change, counted once at cycle start.`,
        `${counts}<p>${costExample(data, current)} ${current.kind === 'skip' ? 'This arithmetic is illustrative because this replay candidate was skipped.' : ''}</p>`,
        'H’s time already includes its B/tool-change sequence, so do not add lockout to H again. V starts after that lockout. H tool changes remain blocked for their whole B sequence. If the first stretch has no B event, its rule is max(H, pre + W).');
    case 9:
      return panel('Compare this candidate’s complete elapsed time with the best plan already stored for the same completed counts.',
        `${code('best[s−1][i] + cost')} is the candidate total: earlier cycle time plus this stretch’s added time. ${code('best[s][j]')} is the stored alternative for the same destination. ${code('<')} means strictly shorter; an equal candidate does not replace the stored split. ${code('∞')} marks an unreached destination and loses to any finite candidate.`,
        `${counts}<p>${code(`${fmt(current.previous)} + ${fmt(current.cost)} = ${fmt(current.total)} s`)} compared with the previous ${destination}${code(` = ${fmt(current.before)} s`)}. ${current.kind === 'skip' ? 'The comparison is not executed because the predecessor is unreachable.' : current.better ? 'The candidate is shorter, so lines 10 and 11 save it.' : current.total === current.before ? 'The totals are equal: keep the existing time and boundary.' : 'The candidate is longer: keep the existing plan.'}</p>`,
        'The objective is shortest total cycle time. There is no additional “finish V earliest” rule: increasing i with strict less-than keeps the first tried boundary when costs tie, which can leave V in a later stretch.');
    case 10:
      return panel('Store a shorter cycle time for this combination of completed H and V work.',
        `${code('best[s][j]')} is the destination cell. The arrow means replace that cell’s stored value with ${code('best[s−1][i] + cost')}, measured in elapsed seconds from cycle start. This assignment runs only when line 9 finds a strictly shorter candidate. It does not add the candidate to the previous destination value.`,
        `${counts}<p>${current.kind !== 'skip' && current.better ? `${destination} changes from ${seconds(current.before)} to ${seconds(current.total)}, using predecessor ${source}${code(` = ${fmt(current.previous)}`)} plus ${seconds(current.cost)} for this stretch.` : `No write occurs for this candidate. ${current.kind === 'skip' ? 'It was skipped before comparison.' : `Its total ${fmt(current.total)} is not less than the stored ${fmt(current.before)}.`}`} The counts s = ${s}, j = ${j} stay the same while competing i boundaries are tested.</p>`,
        'This updates the planning table, rather than commanding either spindle. The table keeps one shortest time for each reachable amount of completed work.');
    case 11:
      return panel('Remember which V boundary produced the shorter time, so the operation groups can be recovered later.',
        `${code('from')} is a second table with the same rows and columns as best. ${code('from[s][j] = i')} stores a count: how many V pieces were already finished before this stretch. It is not a duration, a wait-code number, or an operation identity. The predecessor is therefore row s−1, column i.`,
        `${counts}<p>${current.kind !== 'skip' && current.better ? `${code(`from[${s}][${j}] ← ${i}`)} records the boundary used for the newly saved ${seconds(current.total)} total. Later, that boundary assigns ${esc(current.group)} to stretch ${s}.` : `This candidate does not change ${code(`from[${s}][${j}]`)} because no shorter time was accepted. Equal-time candidates preserve the already stored boundary.`} Saving both the time and its boundary links the final number to actual operations.</p>`,
        'These remembered choices eventually say which V operations belong between each pair of B events. Source order remains intact because every remembered group is a contiguous slice.');
    case 12:
      return panel('Read the shortest complete cycle time after the search has filled the table.',
        `${code('S')} is all ${data.S} H stretches; ${code('n')} is all ${data.n} V pieces. ${code('best[S][n]')} is the cell where both channels’ entire ordered workloads are completed. ${code('cycle')} names that elapsed-time result in seconds. Other cells describe partial work and cannot be used as the completed cycle.`,
        `<p>${code(`cycle = best[${data.S}][${data.n}] = ${fmt(result.plan.cycle)} s`)}. This is the result after all candidates have been evaluated, even if the animation currently displays an earlier table. The selected V groups contain ${code(array(result.plan.groups.map(group => group.length)))} operations per H stretch. Line 13 starts recovering those choices from the remembered boundaries.</p>`,
        'Cycle time includes shared work, B lockouts, and required waiting. It is not H time plus V time: the two spindles run concurrently wherever this model allows.');
    case 13:
    case 14: {
      const walk = Number.isInteger(context.walkStretch) ? Math.max(1, Math.min(data.S, context.walkStretch)) : data.S;
      const [before, after] = result.plan.cuts[walk - 1];
      const group = data.v.slice(before, after);
      const next = data.v[before];
      const remembered = cell(context.from ?? result.plan.from, walk, after, null);
      if (Number(lineNumber) === 13) return panel('Start at the finished cycle and walk backward through the choices that produced it.',
        `${code('j ← n')} starts with all V pieces complete. ${code('s ← S down to 1')} visits the final H stretch first, then earlier stretches. Here s is a one-based stretch number; j is the cumulative V count at that stretch’s end. Reading from on the next line supplies the earlier count. This recovery step is often called backtracking: following remembered choices backward.`,
        `<p>The walk starts at ${code(`s = ${data.S}, j = ${data.n}`)}. ${context.walkStretch === undefined ? 'For the final stretch' : 'At the selected walk step'}, ${code(`s = ${walk}, j = ${after}`)} and the chosen predecessor count is ${code(before)}. ${code(`from[${walk}][${after}]`)} ${remembered === null ? 'has not been recorded in the displayed replay table yet; these values describe the finished plan' : `contains ${esc(fmt(remembered))}`}. Earlier iterations of the walk will use a smaller j, rather than resetting j to n each time.</p>`,
        'Walking backward only reconstructs the schedule. Neither spindle runs backward; the resulting operation groups are still executed in their original forward order.');
      const placement = !data.stretches[walk - 1].event ? 'This stretch has no B event, so it adds no V handshake.' : next ? `Its event’s V handshake is attached before the B-dependent setup of V${before + 1}, ${code(next.text)}, after the required tool change.` : 'No V operation remains, so its handshake is attached before the vertical program end.';
      return panel('Recover this stretch’s V group, then move to the preceding stretch’s table cell.',
        `${code('from[s][j]')} gives the earlier completed-piece count i. ${code('group[s]')} receives pieces i+1 through j and their matching V operation records. ${code('j ← from[s][j]')} then replaces j with i before the loop moves to s−1. The old j must be used to form the group before it is changed.`,
        `<p>${code(`from[${walk}][${after}] = ${before}`)} means ${code(`group[${walk}] = ${before === after ? '[]' : `p${before + 1} … p${after}`}`)}: ${group.length ? group.map(op => code(op.text)).join('; ') : 'no V operations in this stretch'}. Then ${code(`j ← ${before}`)}; ${walk > 1 ? `the next cell is ${code(`best[${walk - 1}][${before}]`)}` : 'the walk is complete'}. ${placement}</p>`,
        'An empty group still performs its event handshake. Consecutive empty stretches stack ordered V waits on the next operation or the program footer, rather than dropping events or inventing work.');
    }
    default:
      return '<p>Select a pseudocode line from 1 through 14.</p>';
  }
}

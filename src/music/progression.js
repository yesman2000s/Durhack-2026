export const exercises = [
  { id: 'squat', name: 'Squat', instrument: 'Drums', color: '#b7f5cf',
    segments: [[1, 'Kick'], [3, 'Snare'], [4, 'Hi-hats']] },
  { id: 'step-up', name: 'Step-up', instrument: 'Bass', color: '#f5cb93',
    segments: [[1, 'Root notes'], [3, 'Passing notes'], [4, 'Octave accents']] },
  { id: 'calf-raise', name: 'Calf raise', instrument: 'Keys', color: '#cfc5ff',
    segments: [[1, 'Chords'], [3, 'Syncopation'], [4, 'High voicings']] },
  { id: 'wall-push-up', name: 'Wall push-up', instrument: 'Melody', color: '#f6b5c3',
    segments: [[1, 'Main phrase'], [3, 'Answer phrase'], [4, 'High accents']] },
];

export const demoProfiles = [
  { id: 'early', name: 'Early mix', streaks: { squat: 3, 'step-up': 1, 'calf-raise': 0, 'wall-push-up': 0 } },
  { id: 'steady', name: 'Steady mix', streaks: { squat: 4, 'step-up': 1, 'calf-raise': 0, 'wall-push-up': 0 } },
  { id: 'full', name: 'Full mix', streaks: { squat: 4, 'step-up': 3, 'calf-raise': 4, 'wall-push-up': 4 } },
];

export function earnedSegments(exercise, streak = 0) {
  return exercise.segments.filter(([days]) => streak >= days).length;
}

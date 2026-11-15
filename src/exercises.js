export const EXERCISES = {
  squat: {
    title: 'Squat',
    setup: 'Stand side-on with your head and feet in view. Use a stable chair for support if you prefer.',
    framing: 'Stand side-on. Keep your head and feet in view.',
    start: 'Stand comfortably',
    action: 'Lower once, stand back up, and hold briefly.',
    phases: { start: 'Standing', descent: 'Lowering', bottom: 'Bottom', ascent: 'Rising', finish: 'Standing again' },
    reference: 'https://player.vimeo.com/video/878233151',
  },
  'push-up': {
    title: 'Push-up',
    setup: 'Show your hands, head, and feet from roughly the side. Hold your comfortable top position with your palms and toes on the floor; your elbows do not need to lock straight.',
    framing: 'Keep your hands, head, and feet visible, roughly side-on.',
    start: 'Hold your top position',
    action: 'Lower your chest toward the floor, then press back up and hold briefly.',
    phases: { start: 'High plank', descent: 'Lowering', bottom: 'Lowest point', ascent: 'Pressing up', finish: 'High plank again' },
    rangeLabel: 'Elbow bend',
    reference: 'https://www.nasm.org/resource-center/exercise-library/push-up',
    guidance: ['Begin near the top with your palms on the floor and your legs extended behind you. A slight elbow bend is okay.', 'Hold still briefly so the camera can learn your starting position.', 'Lower through a comfortable range, then press back to your starting position and hold briefly.'],
  },
  'knee-raise': {
    title: 'Knee raise',
    setup: 'Stand side-on with both feet on the floor and your arms free. Lift the knee closest to the camera.',
    framing: 'Stand side-on with both feet in view.',
    start: 'Stand with both feet down',
    action: 'Raise the near knee once, then lower your foot and stand briefly.',
    phases: { start: 'Standing', descent: 'Lifting knee', bottom: 'Highest point', ascent: 'Lowering knee', finish: 'Foot down' },
    rangeLabel: 'Thigh lift',
    reference: 'https://www.nhs.uk/Livewell/fitness/Pages/how-to-warm-up.aspx',
    guidance: ['Stand upright with both feet down and your arms free for balance.', 'Lift the near knee forward to a comfortable height without hopping.', 'Lower your foot and pause with both feet down. Turn around to practise the other leg.'],
  },
  'heel-raise': {
    title: 'Heel raise',
    setup: 'Stand side-on with both feet flat to start. Keep your heels and toes in view; your arms can move for balance.',
    framing: 'Stand side-on. Show your heels and toes.',
    start: 'Plant both feet flat',
    action: 'Lift both heels once, then lower them to the floor and hold briefly.',
    phases: { start: 'Feet flat', descent: 'Lifting heels', bottom: 'Highest point', ascent: 'Lowering heels', finish: 'Feet flat again' },
    rangeLabel: 'Heel lift',
    reference: 'https://www.uclh.nhs.uk/patients-and-visitors/patient-information-pages/home-exercises-improve-strength-and-balance-following-hospital-admission',
    guidance: ['Stand upright with both feet flat and your arms free for balance.', 'Raise both heels and balance on the balls of your feet.', 'Keep your toes planted as you lower both heels.'],
  },
};

export function exerciseInfo(id) {
  return EXERCISES[id] ?? EXERCISES.squat;
}

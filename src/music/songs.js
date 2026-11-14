export const songs = [
  { id: 'hiphop', genre: 'Hip-hop', title: 'Griphop', bpm: 90, isrc: 'USUAN1100413',
    stems: ['drums', 'bass', 'other'] },
  { id: 'electronic', genre: 'EDM', title: 'EDM Detection Mode', bpm: 128, isrc: 'USUAN1500026',
    stems: ['drums', 'bass', 'other'] },
  { id: 'rock', genre: 'Rock', title: 'Jet Fueled Vixen', bpm: 100, isrc: 'USUAN1700079',
    stems: ['drums', 'bass', 'guitar', 'other', 'piano'] },
];

export function sourceUrl(song) {
  return 'https://incompetech.com/music/royalty-free/index.html?Search=Search&isrc=' + song.isrc;
}

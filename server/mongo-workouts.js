import { MongoClient } from 'mongodb';

export function createMongoWorkouts(uri, database = 'compose') {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 4000 });
  const collection = client.db(database).collection('workout_scores');
  let index;

  return {
    async sync(userId, readWorkouts) {
      index ??= collection.createIndex({ userId: 1, sequence: -1 }).catch((error) => {
        index = undefined;
        throw error;
      });
      await index;
      const latest = await collection.findOne({ userId }, { sort: { sequence: -1 }, projection: { sequence: 1 } });
      let after = latest?.sequence ?? 0;
      // Each batch is ordered. After a partial write, the highest sequence in
      // MongoDB is still a safe resume point. The attempt ID makes retries idempotent.
      for (;;) {
        const workouts = readWorkouts(userId, after, 200);
        if (!workouts.length) return;
        await collection.bulkWrite(workouts.map(({ attemptId, ...workout }) => ({
          updateOne: {
            filter: { _id: attemptId },
            update: { $setOnInsert: workout },
            upsert: true,
          },
        })), { ordered: true });
        after = workouts.at(-1).sequence;
      }
    },
    close: () => client.close(),
  };
}

module.exports = {
  async up(db) {
    await db.collection('orders').updateMany({ status: { $exists: false } }, { $set: { status: 'open' } });
    await db.collection('orders').createIndex({ status: 1 });
  },
  async down(db) {
    await db.collection('orders').updateMany({}, { $unset: { status: '' } });
  },
};

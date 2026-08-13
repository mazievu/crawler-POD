const database = require('../src/database');
const { enrichEtsyImages } = require('../src/etsy-image-enrichment');

const parsedLimit = Number.parseInt(process.argv[2], 10);
const limit = Number.isFinite(parsedLimit) ? parsedLimit : 25;

enrichEtsyImages({ database, limit })
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

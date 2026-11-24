// Dev-server hook (picked up automatically by react-scripts): serves the project's
// performance/ folder at /performance so the stage reads the real decision record
// (performance/decision-record.json, performance/runs/<id>/...) and its voice audio.
const path = require('path');
const express = require('express');

module.exports = function setup(app) {
  app.use('/performance', express.static(path.join(__dirname, '..', 'performance'), { etag: false, maxAge: 0 }));
};

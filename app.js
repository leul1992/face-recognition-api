const express = require("express");
const faceapi = require("face-api.js");
const { Canvas, Image } = require("canvas");
const canvas = require("canvas");
const fileUpload = require("express-fileupload");
const { connectToDb } = require("./db/conn");
const FaceModel = require("./schema/face");
faceapi.env.monkeyPatch({ Canvas, Image });

const app = express();

app.use(
  fileUpload({
    useTempFiles: true,
  })
);

async function LoadModels() {
  // Load the models
  // __dirname gives the root directory of the server
  await faceapi.nets.faceRecognitionNet.loadFromDisk(__dirname + "/models");
  await faceapi.nets.faceLandmark68Net.loadFromDisk(__dirname + "/models");
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(__dirname + "/models");
}
LoadModels();

async function uploadLabeledImages(images, label) {
  try {
    // Map each image to a promise that processes it
    const descriptionsPromises = images.map(async (image) => {
      const img = await canvas.loadImage(image);
      const detection = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();
      return detection ? detection.descriptor : null;
    });

    // Use Promise.all to await all promises concurrently
    const descriptions = await Promise.all(descriptionsPromises);

    // Filter out null values (failed detections)
    const validDescriptions = descriptions.filter(descriptor => descriptor !== null);

    // Create a new face document with the given label and save it in DB
    const createFace = new FaceModel({
      label: label,
      descriptions: validDescriptions,
    });

    await createFace.save();
    return true;
  } catch (error) {
    console.error("Error uploading labeled images:", error);
    return false;
  }
}

async function getDescriptorsFromDB(image) {
  try {
    // Fetch only relevant data (descriptors) from the database
    const faces = await FaceModel.find({}, { label: 1, descriptions: 1 });

    // Check if there are no missing persons in the database
    if (!faces || faces.length === 0) {
      return {error: "There is No Data in the DataBase"}
    }

    // Process the data and create faceapi.LabeledFaceDescriptors
    const labeledFaceDescriptors = faces.map((face) => {
      const descriptions = face.descriptions.map((desc) => new Float32Array(Object.values(desc)));
      return new faceapi.LabeledFaceDescriptors(face.label, descriptions);
    });

    // Load face matcher with the processed face descriptors
    const faceMatcher = new faceapi.FaceMatcher(labeledFaceDescriptors, 0.6);

    // Read and process the image
    const img = await canvas.loadImage(image);
    const temp = faceapi.createCanvasFromMedia(img);
    const displaySize = { width: img.width, height: img.height };
    faceapi.matchDimensions(temp, displaySize);

    // Find matching faces
    const detections = await faceapi.detectAllFaces(img).withFaceLandmarks().withFaceDescriptors();
    const resizedDetections = faceapi.resizeResults(detections, displaySize);
    const results = resizedDetections.map((d) => faceMatcher.findBestMatch(d.descriptor));

    return results;
  } catch (error) {
    console.error("Error getting descriptors from the database:", error);
    throw error; // Re-throw the error to handle it at a higher level if needed
  }
}

app.get('/', (req, res) => {
  res.status(200).json({message: 'Server is up and running!'});
});

app.post("/checkFace", async (req, res) => {
  try {
    const file1 = req.files.File1?.tempFilePath;

    if (!file1) {
      return res.status(400).json({ error: "Image is required." });
    }

    const result = await getDescriptorsFromDB(file1);

    res.json({ result });
  } catch (error) {
    console.error("Error checking face:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/create-face", async (req, res) => {
  const files = req.files;
  const label = req.body.label;

  if (!label) {
    return res.status(400).json({ message: "Label is required." });
  }

  const imagePaths = Object.values(files).map(file => file.tempFilePath);
  
  if (imagePaths.length === 0) {
    return res.status(400).json({ message: "No images provided." });
  }

  try {
    let result = await uploadLabeledImages(imagePaths, label);
    if (result) {
      res.json({ message: "Face stored" });
    } else {
      res.json({ message: "Something went wrong" });
    }
  } catch (error) {
    console.error("Error uploading images:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// add your mongo key instead of the ***
connectToDb()
  .then(() => {
    app.listen(process.env.PORT || 5000);
    console.log("DB connected and server us running.");
  })
  .catch((err) => {
    console.log(err);
  });
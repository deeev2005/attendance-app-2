const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const https = require('https');

const app = express();
app.use(express.json());

// Initialize Firebase Admin using secret file
let serviceAccount;
try {
  const secretPath = path.join(__dirname, 'serviceAccountKey.json');
  serviceAccount = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
  console.log('✅ Firebase service account loaded from file');
} catch (error) {
  console.error('❌ Error loading serviceAccountKey.json:', error.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ==================================================================
// 👂 MONITOR NOTIFICATION COLLECTION & SEND FCM
// ==================================================================
db.collection('notification').onSnapshot((snapshot) => {
  snapshot.docChanges().forEach((change) => {
    if (change.type === 'added') {
      const data = change.doc.data();
      const { uid, subjectId, status } = data;
      
      if (!uid || !subjectId || !status) return;

      console.log(`🔔 New notification for ${uid}: ${status} - ${subjectId}`);

      try {
        // Get user data for FCM token and image/link
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) {
          console.log(`❌ User ${uid} not found`);
          return;
        }

        const userData = userDoc.data();
        const fcmToken = userData.fcmToken;
        const imageUrl = userData.image_1 || '';
        const clickLink = userData.link_1 || '';

        if (!fcmToken) {
          console.log(`❌ No FCM token for user ${uid}`);
          return;
        }

        // Get subject name
        const subjectDoc = await db.collection('users').doc(uid).collection('subjects').doc(subjectId).get();
        const subjectName = subjectDoc.exists ? subjectDoc.data().name || subjectId : subjectId;

        // Get date from notification dateTime field
        const dateTime = data.dateTime ? data.dateTime.toDate() : new Date();
        const formattedDate = dateTime.toLocaleDateString('en-IN', { 
          day: '2-digit', 
          month: 'short', 
          year: 'numeric' 
        });

        // Send FCM notification
        await sendVisibleNotification(uid, fcmToken, status, subjectName, formattedDate, imageUrl, clickLink);

      } catch (err) {
        console.error(`❌ Error processing notification for ${uid}:`, err.message);
      }
    }
  });
});

// ==================================================================
// 🚀 Send Visible FCM Notification (DATA-ONLY MESSAGE)
// ==================================================================
async function sendVisibleNotification(userId, fcmToken, status, subjectName, date, imageUrl, clickLink) {
  try {
    console.log('🔄 Getting access token...');
    
    // Get access token using googleapis
    const jwtClient = new google.auth.JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging']
    });
    
    const tokens = await jwtClient.authorize();
    console.log('✅ Access token obtained');

    // Prepare notification message
    const notificationTitle = 'Attendance Update';
    const notificationBody = `Marked ${status} for ${subjectName} on ${date}`;

    // ONLY send notification if image is available
    if (!imageUrl) {
      console.log('⚠️ No image available, skipping notification');
      return;
    }

    // Build FCM message - DATA ONLY (no notification payload)
    const message = {
      message: {
        token: fcmToken,
        data: {
          title: notificationTitle,
          body: notificationBody,
          image: imageUrl,
          link: clickLink || ''
        },
        android: {
          priority: 'high'
        }
      }
    };

    console.log(`🖼️ Sending data-only message with image: ${imageUrl}`);

    // Send request
    const data = JSON.stringify(message);
    const options = {
      hostname: 'fcm.googleapis.com',
      port: 443,
      path: `/v1/projects/${serviceAccount.project_id}/messages:send`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log(`✅ Data message sent to ${userId}`);
        } else {
          console.log(`❌ FCM Error Status: ${res.statusCode}, Response: ${responseData}`);
        }
      });
    });

    req.on('error', (error) => {
      console.error(`❌ FCM Request failed for ${userId}:`, error.message);
    });

    req.write(data);
    req.end();

  } catch (err) {
    console.error(`❌ Error sending notification to ${userId}:`, err.message);
  }
}

// ==================================================================
// 🩺 Health Check & Ping
// ==================================================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.get('/ping', (req, res) => res.status(200).send('OK'));

// ==================================================================
// 🚀 SERVER START
// ==================================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log('🚀 Server started...');
  console.log('👂 Monitoring notification collection for new entries...');
  console.log(`✅ Server running on port ${PORT}`);
});

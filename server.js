/*
 * Copyright 2016-present, Facebook, Inc. 
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* jshint node: true, devel: true */
'use strict';

const 
  bodyParser = require('body-parser'),
  config = require('config'),
  crypto = require('crypto'),
  express = require('express'),
  https = require('https'),  
  request = require('request'),
  apiai = require('apiai'),
  mongoose = require('./mongoose-connect.js'),
  course = require('./models/courses.js');

var app = express();
app.set('port', process.env.PORT || 5000);
app.set('view engine', 'ejs');
app.use(bodyParser.json({ verify: verifyRequestSignature }));
app.use(express.static('public'));

mongoose.connect(app);

/*
 * Connecting Firebase Database with admin privileges
 */
var firebase = require("firebase");
// Initialize Firebase
firebase.initializeApp({
  serviceAccount: "./config/database-service-account-key.json",
  databaseURL: "https://course-finder-bot-databa-1db35.firebaseio.com/"
});

// As an admin, the app has access to read and write all data, regardless of Security Rules
var db = firebase.database();

/**
 * Returns a promise, if user does not exist, creates a user and resolves to true,
 * If user already exists, returns a promise which resolves to false;
 * 
 * Returns Promise<boolean> 
 */
function createUser(uid) {
  return new Promise(function(resolve, reject) {
    var courseListRef = db.ref('UserCourses');
    courseListRef.once("value")
      .then(function(snapshot) {
        console.log('hello: ' + uid);
        var uidRetrieved = snapshot.child(uid).val();
        if (uidRetrieved === null) {
          console.log('you do not exist');
          // create a new user:
          courseListRef.child(uid).set({
            courseList: ['null']
          });
          resolve(true);
        } else {
          // dont create a new user
          console.log('welcome back: ' + uid);
          resolve(false);
        }
      });
  });
}

/**
 * Returns a Promise which resolves with the list of courses the user has registered
 */
function getUserCourseList(uid) {
  return new Promise(function(resolve, reject) {
    var courseListRef = db.ref('UserCourses/' + uid);
    // get existing course list:
    courseListRef.once("value")
      .then(function(snapshot) {
        // key() is the last path so UID
        // child(path) is from after the key
        var courseList = snapshot.child('courseList').val()
        resolve(courseList);
      });
  }); 
}


/**
 * Returns a promise, when successfully added, resolves with boolean true,
 * If failed to add, resolves with false
 * 
 * Returns Promise<boolean> 
 */
function addClass(uid, sln) {
  return new Promise(function(resolve, reject) {
    var courseListRef = db.ref('UserCourses/' + uid);
    // get existing course list:
    courseListRef.once("value")
      .then(function(snapshot) {
        // key() is the last path so UID
        // child(path) is from after the key
        var courseList = snapshot.child('courseList').val()
        // check if class exists in the list:
        if (courseList.indexOf(sln) == -1) {
          // not yet in the list:
          courseList.push(sln);
          // update it:
          courseListRef.update({
            courseList: courseList,
          });
          resolve(true);
        } else {
          resolve(false);
        }
      });
  }); 
}

function removeClass(uid, sln) {
  return new Promise(function(resolve, reject) {
    var courseListRef = db.ref('UserCourses/' + uid);
    // get existing course list:
    courseListRef.once("value")
      .then(function(snapshot) {
        // key() is the last path so UID
        // child(path) is from after the key
        var courseList = snapshot.child('courseList').val()
        // check if class exists in the list:
        if (courseList.indexOf(sln) == -1) {
            console.log("class not in list");
          // not in the list, can't delete!!
          resolve(false);
        } else {
          var index = courseList.indexOf(sln);
          var removed = courseList.splice(index, 1);
          // update it:
          courseListRef.update({
            courseList: courseList,
          });
          console.log("removed: " + removed);
          resolve(true);
        }
      });
  }); 
}

var apiaiApp = apiai(config.get('apiaiClientAccessToken'));

/*
 * Be sure to setup your config values before running this code. You can 
 * set them using environment variables or modifying the config file in /config.
 *
 */

// App Secret can be retrieved from the App Dashboard
const APP_SECRET = (process.env.MESSENGER_APP_SECRET) ? 
  process.env.MESSENGER_APP_SECRET :
  config.get('appSecret');

// Arbitrary value used to validate a webhook
const VALIDATION_TOKEN = (process.env.MESSENGER_VALIDATION_TOKEN) ?
  (process.env.MESSENGER_VALIDATION_TOKEN) :
  config.get('validationToken');

// Generate a page access token for your page from the App Dashboard
const PAGE_ACCESS_TOKEN = (process.env.MESSENGER_PAGE_ACCESS_TOKEN) ?
  (process.env.MESSENGER_PAGE_ACCESS_TOKEN) :
  config.get('pageAccessToken');

// URL where the app is running (include protocol). Used to point to scripts and 
// assets located at this address. 
const SERVER_URL = (process.env.SERVER_URL) ?
  (process.env.SERVER_URL) :
  config.get('serverURL');

if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN && SERVER_URL)) {
  console.error("Missing config values");
  process.exit(1);
}

/*
 * Use your own validation token. Check that the token used in the Webhook 
 * setup is the same token used here.
 *
 */
app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === VALIDATION_TOKEN) {
    console.log("Validating webhook");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);          
  }  
});


/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page. 
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 *
 */
app.post('/webhook', function (req, res) {
  var data = req.body;

  // Make sure this is a page subscription
  if (data.object == 'page') {
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function(pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;

      // Iterate over each messaging event
      pageEntry.messaging.forEach(function(messagingEvent) {
        if (messagingEvent.optin) {
          receivedAuthentication(messagingEvent);
        } else if (messagingEvent.message) {
          receivedMessage(messagingEvent);
        } else if (messagingEvent.delivery) {
          receivedDeliveryConfirmation(messagingEvent);
        } else if (messagingEvent.postback) {
          receivedPostback(messagingEvent);
        } else if (messagingEvent.read) {
          receivedMessageRead(messagingEvent);
        } else if (messagingEvent.account_linking) {
          receivedAccountLink(messagingEvent);
        } else {
          console.log("Webhook received unknown messagingEvent: ", messagingEvent);
        }
      });
    });

    // Assume all went well.
    //
    // You must send back a 200, within 20 seconds, to let us know you've 
    // successfully received the callback. Otherwise, the request will time out.
    res.sendStatus(200);
  }
});

/*
 * This path is used for account linking. The account linking call-to-action
 * (sendAccountLinking) is pointed to this URL. 
 * 
 */
app.get('/authorize', function(req, res) {
  var accountLinkingToken = req.query.account_linking_token;
  var redirectURI = req.query.redirect_uri;

  // Authorization Code should be generated per user by the developer. This will 
  // be passed to the Account Linking callback.
  var authCode = "1234567890";

  // Redirect users to this URI on successful login
  var redirectURISuccess = redirectURI + "&authorization_code=" + authCode;

  res.render('authorize', {
    accountLinkingToken: accountLinkingToken,
    redirectURI: redirectURI,
    redirectURISuccess: redirectURISuccess
  });
});

/*
 * Verify that the callback came from Facebook. Using the App Secret from 
 * the App Dashboard, we can verify the signature that is sent with each 
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    // For testing, let's log an error. In production, you should throw an 
    // error.
    console.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];
1
    var expectedHash = crypto.createHmac('sha1', APP_SECRET)
                        .update(buf)
                        .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

/*
 * Authorization Event
 *
 * The value for 'optin.ref' is defined in the entry point. For the "Send to 
 * Messenger" plugin, it is the 'data-ref' field. Read more at 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
 *
 */
function receivedAuthentication(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfAuth = event.timestamp;

  // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
  // The developer can set this to an arbitrary value to associate the 
  // authentication callback with the 'Send to Messenger' click event. This is
  // a way to do account linking when the user clicks the 'Send to Messenger' 
  // plugin.
  var passThroughParam = event.optin.ref;

  console.log("Received authentication for user %d and page %d with pass " +
    "through param '%s' at %d", senderID, recipientID, passThroughParam, 
    timeOfAuth);

  // When an authentication is received, we'll send a message back to the sender
  // to let them know it was successful.
  sendTextMessage(senderID, "Authentication successful");
}

/*
 * Message Event
 *
 * This event is called when a message is sent to your page. The 'message' 
 * object format can vary depending on the kind of message that was received.
 * Read more at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-received
 *
 * For this example, we're going to echo any text that we get. If we get some 
 * special keywords ('button', 'generic', 'receipt'), then we'll send back
 * examples of those bubbles to illustrate the special message bubbles we've 
 * created. If we receive a message with an attachment (image, video, audio), 
 * then we'll simply confirm that we've received the attachment.
 * 
 */
function receivedMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  console.log("Received message for user %d and page %d at %d with message:", 
    senderID, recipientID, timeOfMessage);
  console.log(JSON.stringify(message));

  var isEcho = message.is_echo;
  var messageId = message.mid;
  var appId = message.app_id;
  var metadata = message.metadata;

  // You may get a text or attachment but not both
  var messageText = message.text;
  var messageAttachments = message.attachments;
  var quickReply = message.quick_reply;

  if (isEcho) {
    // Just logging message echoes to console
    console.log("Received echo for message %s and app %d with metadata %s", 
      messageId, appId, metadata);
    return;
  } else if (quickReply) {
    var quickReplyPayload = quickReply.payload;
    console.log("Quick reply for message %s with payload %s",
      messageId, quickReplyPayload);

    sendTextMessage(senderID, "Quick reply tapped");
    return;
  }

    // {
    //  "id": "81a675f0-b1d6-400f-ba6b-bb5aba339e2b",
    //  "timestamp": "2016-10-16T08:58:22.25Z",
    //  "result": {
    //    "source": "agent",
    //    "resolvedQuery": "add cse 344",
    //    "action": "",
    //    "actionIncomplete": false,
    //    "parameters": {
    //      "Department": "CSE",
    //      "Functions": "add",
    //      "number": "344"
    //    },
    //    "contexts": [],
    //    "metadata": {
    //      "intentId": "c35deba0-bcc1-4835-afd6-407b93c0b04b",
    //      "webhookUsed": "false",
    //      "intentName": "Search function"
    //    },
    //    "fulfillment": {
    //      "speech": ""
    //    },
    //    "score": 0.6666666666666666
    //  },
    //  "status": {
    //    "code": 200,
    //    "errorType": "success"
    //  },
    //  "sessionId": "490a07d7-2d0f-4e77-925d-3d90edef9aa2"
    // }

    // {
    //   "sln": "-1",
    //   "prefix": "BasketWeaving",
    //   "number": "-111",
    //   "nameOfclassName": "Weaving Baskets 101",
    //   "days":"mwf",
    //   "start":1245,
    //   "end":2:25,
    //   "section":false,
    //   "instructor":"shayan",
    //   "open":false,
    //   "generalEducation":"INS",
    //   "writing":false,
    //   "link":"www.fakelink.com"
    // }


  if (messageText) {
    var options = {
      sessionId: 'senderID'
    }
    switch(messageText){
      case 'admin:testPreloadCourse':
        course.createCourse({
          sln:-1,
          prefix:"UBW",
          number:101,
          nameOfclassName:"Underwater basket weaving 101",
          days:"mwf",
          start:1130,
          end:1220,
          isSection:false,
          instructor:"Shayan",
          isOpen:true,
          generalEd:"QNS",
          isWriting:true,
          link:"fakelink.com"
        });
        break;
      default:
        break;

    }
    var request = apiaiApp.textRequest(messageText, options);
    request.on('response', function(response) {
        createUser(senderID);
        var results = response.result;
        var func = results.parameters.Functions;
        var department = results.parameters.Departments;
        var classNum = results.parameters.number;
        var intro = results.parameters.Introduction;
        var help = results.parameters.help;
        var departmentClass = department + " " + classNum;
        if (help != undefined && help != "") {
          sendTextMessage(senderID, "Let me show you how I can help you! You can search for a class by typing \"search\" or " + 
            "I can add a class by Course and Title by typing \"add\" or remove a class by typing \"remove\"");
        } else  if (intro != undefined && intro != "") {
            switch(intro) {
                case 'intro':
                    sendTextMessage(senderID, "Oh hi there! I'm a course finder!");
                    break;
                case 'nice':
                    sendTextMessage(senderID, "Nice seeing you there! How can I help you today?");
                    break;
                case 'how':
                    sendTextMessage(senderID, "It has been a great day! What can I help you today?");
                    break;
                default:
                    sendTextMessage(senderID, "I'm sorry. I didn't understand what you said.");
            }
        } else {
            switch(func){
                case 'myplan':
                    getUserCourseList(senderID).then(function(list) {
                        var text = "";
                        if (list.length === 0) {
                            text = "You have not added any classes to your list. You may want to do so now!";
                        } else {
                            text = "These are the classes I saved for you:";
                            list.forEach(function(entry) {
                                if (entry !== "null") {
                                    text += "\n " + entry;
                                } 
                            });
                        }

                        sendTextMessage(senderID, text);
                    });
                    break;
                case 'list':
                    console.log("finding all courses in " + department + " department");
                    var result = course.getClassByDepartment({
                        prefix: department
                    }, function (err, name) {
                        if (typeof name[0] === 'undefined') {
                            console.log("error " + department);
                            sendTextMessage(senderID, "these classes could not be found");
                        } else {
                            console.log("success " + department);
                            sendTextMessage(senderID, "Here is all the classes info: \n" +
                            "Class: " + name[0].prefix + " " + name[0].number + " \n" +
                            "Name of the class: " + name[0].nameOfclassName + " \n"
                            );
                        }
                    });
                    break;
                case 'add':
                    course.getClassByClassName({
                        prefix: department,
                        number:classNum
                    },function (err, name) {
                        if (typeof name[0] === 'undefined') {
                            console.log("error " + departmentClass)
                        sendTextMessage(senderID, "this class could not be found");
                        } else {
                            console.log("success, adding " + departmentClass)
                        addClass(senderID, name[0].sln).then(function(bool) {
                            if (bool) {
                                sendTextMessage(senderID, "Added class " + name[0].nameOfclassName + ", SLN: " + name[0].sln + ", to your list");
                            } else {
                                sendTextMessage(senderID, "Fail to add class");
                            }
                        });

                        }
                    });
                    break;
                case 'find':
                    console.log("finding class " + departmentClass)
                        var result = course.getClassByClassName({
                            prefix: department,
                            number:classNum
                        },function (err, name) {
                            if (typeof name[0] === 'undefined') {
                                console.log("error " + departmentClass)
                            sendTextMessage(senderID, "this class could not be found");
                            } else {
                                console.log("success " + departmentClass)
                            sendTextMessage(senderID, "Here is the class info: \n" +
                                "SLN " + name[0].sln + " \n" +
                                "Name of the class: " + name[0].nameOfclassName + " \n" +
                                "Start time:  " + name[0].start + " \n" +
                                "End time: " + name[0].end + " \n" +
                                "Is it open? " + name[0].isOpen + " \n" 
                                );
                            }
                        });
                    break;
                case 'remove':
                    
                    var result = course.getClassByClassName({
                            prefix: department,
                            number:classNum
                        },function (err, name) {
                            if (typeof name[0] === 'undefined') {
                                console.log("error " + departmentClass)
                                sendTextMessage(senderID, "this class could not be found");
                            } else {
                                console.log("success " + departmentClass)
                                removeClass(senderID, name[0].sln).then(function(bool) {
                                if (bool) {
                                        console.log("success");
                                    } else {
                                        console.log("fail");
                                    }
                                });
                                sendTextMessage(senderID, "I'll remove class " + departmentClass + ", just a sec!");
                            }
                        });



                
                    break;
                default:
                    sendTextMessage(senderID, "I'm sorry. I didn't understand what you said.");
            }
        }
    });


    request.on('error', function(error) {
        console.log(error);
    });

    request.end();


  } else if (messageAttachments) {
      sendTextMessage(senderID, "Message with attachment received");
  }
}


/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about 
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 *
 */
function receivedDeliveryConfirmation(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var delivery = event.delivery;
    var messageIDs = delivery.mids;
    var watermark = delivery.watermark;
    var sequenceNumber = delivery.seq;

    if (messageIDs) {
        messageIDs.forEach(function(messageID) {
            console.log("Received delivery confirmation for message ID: %s", 
                messageID);
        });
    }

    console.log("All message before %d were delivered.", watermark);
}


/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message. 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 * 
 */
function receivedPostback(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var timeOfPostback = event.timestamp;

    // The 'payload' param is a developer-defined field which is set in a postback 
    // button for Structured Messages. 
    var payload = event.postback.payload;

    console.log("Received postback for user %d and page %d with payload '%s' " + 
            "at %d", senderID, recipientID, payload, timeOfPostback);

    // When a postback is called, we'll send a message back to the sender to 
    // let them know it was successful
    sendTextMessage(senderID, "Postback called");
}

/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 * 
 */
function receivedMessageRead(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;

    // All messages before watermark (a timestamp) or sequence have been seen.
    var watermark = event.read.watermark;
    var sequenceNumber = event.read.seq;

    console.log("Received message read event for watermark %d and sequence " +
            "number %d", watermark, sequenceNumber);
}

/*
 * Account Link Event
 *
 * This event is called when the Link Account or UnLink Account action has been
 * tapped.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
 * 
 */
function receivedAccountLink(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;

    var status = event.account_linking.status;
    var authCode = event.account_linking.authorization_code;

    console.log("Received account link event with for user %d with status %s " +
            "and auth code %s ", senderID, status, authCode);
}





/*
 * Send a text message using the Send API.
 *
 */
function sendTextMessage(recipientId, messageText) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: messageText,
            metadata: "DEVELOPER_DEFINED_METADATA"
        }
    };

    callSendAPI(messageData);
}

/*
 * Turn typing indicator on
 *
 */
function sendTypingOn(recipientId) {
    console.log("Turning typing indicator on");

    var messageData = {
        recipient: {
            id: recipientId
        },
        sender_action: "typing_on"
    };

    callSendAPI(messageData);
}

/*
 * Turn typing indicator off
 *
 */
function sendTypingOff(recipientId) {
    console.log("Turning typing indicator off");

    var messageData = {
        recipient: {
            id: recipientId
        },
        sender_action: "typing_off"
    };

    callSendAPI(messageData);
}

/*
 * Send a message with the account linking call-to-action
 *
 */
function sendAccountLinking(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "button",
                    text: "Welcome. Link your account.",
                    buttons:[{
                        type: "account_link",
                        url: SERVER_URL + "/authorize"
                    }]
                }
            }
        }
    };  

    callSendAPI(messageData);
}

/*
 * Call the Send API. The message data goes in the body. If successful, we'll 
 * get the message id in a response 
 *
 */
function callSendAPI(messageData) {
    request({
        uri: 'https://graph.facebook.com/v2.6/me/messages',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json: messageData

    }, function (error, response, body) {
        if (!error && response.statusCode == 200) {
            var recipientId = body.recipient_id; //uer id
            var messageId = body.message_id;

            if (messageId) {
                console.log("Successfully sent message with id %s to recipient %s", 
                    messageId, recipientId);
            } else {
                console.log("Successfully called Send API for recipient %s", 
                    recipientId);
            }
        } else {
            console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
        }
    });  
}

// Start server
// Webhooks must be available via SSL with a certificate signed by a valid 
// certificate authority.
app.listen(app.get('port'), function() {
    console.log('Messenger Bot Server running on ', app.get('port'));

    // Test server functions:
    // createUser('uid:bye').then(function(bool) {
    //   if (bool) {
    //     console.log("success");
    //   } else {
    //     console.log("fail");
    //   }
    // });
    // createUser('uid:hello').then(function(bool) {
    //   if (bool) {
    //     console.log("success");
    //   } else {
    //     console.log("fail");
    //   }
    // });
    // createUser('uid:bye').then(function(bool) {
    //   if (bool) {
    //     console.log("success");
    //   } else {
    //     console.log("fail");
    //   }
    // });


    // addClass('uid:bye', '23157').then(function(bool) {
    //   if (bool) {
    //     console.log("success");
    //   } else {
    //     console.log("fail");
    //   }
    // });

    // removeClass('uid:bye', '23157').then(function(bool) {
    //   if (bool) {
    //     console.log("success");
    //   } else {
    //     console.log("fail");
    //   }
    // });

    // end of test functions!
});

module.exports = app;


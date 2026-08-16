// Builds games/trial-of-job/lang.simple.json — the same game in words a
// five-year-old can follow by ear.
//
// Rules the writing follows, all of them about a LISTENER rather than a reader:
//   short sentences, concrete nouns, one idea per line, no subordinate clauses,
//   and no line longer than a breath. Passages shrink from paragraphs to two or
//   three lines, because a ninety-word page is a wall of sound to a small child.
//
// HONESTY RULE: the full game quotes the World English Bible verbatim and cites
// chapter and verse. A retelling cannot do that — these are paraphrases — so
// every citation is rewritten to say "the story of Job" or "from Job", never a
// verse reference that would present made-up wording as scripture.
//
// Keys are matched by a distinctive fragment of the ORIGINAL text so this file
// stays readable; the builder resolves each fragment to the exact source string
// and fails loudly on a fragment that matches nothing or matches twice.
import { readFileSync, writeFileSync } from "node:fs";
import { applyLanguage, validateGame } from "../../../packages/engine/src/index.ts";

const GAME = new URL("../game.json", import.meta.url);
const OUT = new URL("../lang.simple.json", import.meta.url);

const res = validateGame(JSON.parse(readFileSync(GAME, "utf8")));
if (!res.ok) throw new Error(res.errors.join("\n"));
const game = res.game;
const sources = applyLanguage(game, { name: "probe" }).missing;

/** [fragment of the original, replacement] — replacement may be lines. */
const R = [
  // ── frame ────────────────────────────────────────────────────────────────
  ["The Trial of Job", "Job's Story"],
  ["Walk with Job from the land of Uz", "Job has a good life. Then he loses it. He asks God why."],
  ["grass", "grass"], ["tree", "tree"], ["road", "road"], ["water", "water"],
  ["floor", "floor"], ["wall", "wall"], ["ashes", "ashes"], ["rock", "rock"],
  ["sand", "sand"], ["ice", "ice"],

  // ── Act I: the altar and the days ────────────────────────────────────────
  ["Job's Altar", "The Stone Where Job Prays"],
  ["It came to pass, when the days of their feasting", [
    "Job had seven boys and three girls.",
    "Every morning he got up early and prayed for them.",
    "He did it every single day.",
  ]],
  ["Job 1:5, WEB", "from the story of Job"],
  ["Dawn. You go up before anyone is awake and offer for the seven sons.", [
    "It is morning. Everyone else is asleep.",
    "You pray for your seven boys.",
  ]],
  ["The second day. The feast has moved", "It is day two. Your children are all together again today."],
  ["Dawn again, and the three daughters.", [
    "Morning again. Today you pray for your three girls.",
    "You say all their names out loud.",
  ]],
  ["The third day. Nothing is wrong.", "It is day three. Nothing bad has happened. That is the news."],
  ["Dawn, and the offering for the days you cannot see", [
    "Morning again. You pray one more time.",
    "You pray for the days you cannot see.",
  ]],
  ["Not yet. Job offered when the days", [
    "Not yet. The day is not finished.",
    "Go and take care of two things first.",
  ]],
  ["The stone is cold and there is nothing left on it to burn.", "The stone is cold now."],

  // ── the household ────────────────────────────────────────────────────────
  ["Job's Wife", "Job's Wife"],
  ["Up before the birds again. Was the smoke straight?", "Up before the birds again! Did your praying go well?"],
  ["Ten of them, and every one in a different house", "Ten children. Every day one of them has us over. I lose track of the days."],
  ["You go up every morning for them. Do you ever go up for yourself?", "You pray for them every morning. Do you ever pray for you?"],
  ["Go on, then. The morning is going.", "Go on. The morning is going."],

  ["Shepherd Boy", "The Boy With the Sheep"],
  ["The Boy Who Knows the Lame One", "The Boy Who Knows Every Sheep"],
  ["Seven thousand, and I know the lame one by her walk.", "There are so many sheep! I know the sore-footed one by how she walks."],
  ["My father kept them before me.", "My dad watched the sheep before me. You were kind to him."],
  ["Master — if I am ever the one who has to come and tell you something", "Sir — if I ever have to tell you bad news, will you let me finish?"],
  ["The hill is quiet, master. Nothing wants anything.", "The hill is quiet. Nobody needs anything."],

  ["The Sheep", "The Sheep"],
  ["The sheep move over the hill like slow weather.\nYou walk the edge", [
    "The sheep move slowly over the hill.",
    "You walk beside them and count.",
  ]],
  ["The lame ewe is at the back of them again.", [
    "One sheep has a sore foot. She is at the back again.",
    "You carry her the rest of the way.",
  ]],
  ["Seven thousand.\nYou have never once counted", [
    "There are so many sheep.",
    "You try to count them all. You always stop partway.",
  ]],
  ["The sheep move over the hill like slow weather.", "The sheep move slowly over the hill."],

  ["The Camels", "The Camels"],
  ["Three thousand camels, kneeling in the shade, chewing.\nThe drivers", [
    "The camels sit in the shade and chew.",
    "The men who look after them wave at you.",
  ]],
  ["You check the pads of the lead camel's feet", [
    "You check the big camel's feet.",
    "They are good feet. She can walk a long way yet.",
  ]],
  ["They are worth more than the house", [
    "The camels are worth more than the house.",
    "You never thought about that before.",
  ]],
  ["Three thousand camels, kneeling in the shade, chewing.", "The camels sit in the shade and chew."],

  ["Zabad the Plowman", "Zabad, Who Digs the Field"],
  ["Five hundred yoke turning the east field", "The big cows are digging up the east field. The donkeys eat beside them."],
  ["You asked my name the first year I came.", "You asked my name my very first year here. Nobody else ever did."],
  ["The west field wants a week yet.", "The west field needs one more week. I will be out there Thursday. All by myself."],
  ["The field is where I left it, master.", "The field is right where I left it."],

  ["The Oxen", "The Big Cows"],
  ["The oxen lean into the yoke. The east field is nearly turned.\nYou put your hand", [
    "The big cows pull hard. They are digging up the field.",
    "You put your hand on one. You can feel her working.",
  ]],
  ["Five hundred yoke.\nThe furrows", [
    "So many big cows!",
    "They make the lines in the field straight. You could never do that.",
  ]],
  ["The east field is turned.\nTomorrow the donkeys", [
    "The east field is all dug up.",
    "Tomorrow the donkeys will come and eat beside them.",
  ]],
  ["The oxen lean into the yoke. The east field is nearly turned.", "The big cows pull hard at the field."],

  ["The Herd Dog", "The Sheep Dog"],
  ["She works the flocks all morning", "She helps with the sheep all morning. Then she walks her patch of grass and checks it."],
  ["She has not settled since the messengers came.", "She will not sit down. She walks and checks and walks again."],
  ["The Donkeys", "The Donkeys"],
  ["Five hundred she-donkeys", "Lots of donkeys. They eat beside the big cows and do not care about anything."],

  ["Job's Eldest Son", "Job's Oldest Son"],
  ["Father, sit. The lamps are still lit", "Sit down, Dad! The lamps are still on."],
  ["It is my day. Tomorrow it is Elior's", "Today everyone comes to my house. Tomorrow it is my brother's turn."],
  ["You send for us and sanctify us every time.", "You pray for us every time. We know you do. That is how you say you love us."],
  ["Sit, father. Or don't", "Sit down, Dad. Or don't. There is food either way."],
  ["Job's Daughter", "Job's Daughter"],
  ["He sent for us at dawn, the way he always does.", "My brother asked us all over this morning. Tomorrow we go to the next one's house."],
  ["You never ask us what we did.", "You never ask us what we did today. I wish you would ask."],
  ["Sit down. You are always standing in the doorway", "Sit down with us. You always stand in the doorway."],
  ["Tomorrow it is my second brother's house.", "Tomorrow we go to my brother's house."],
  ["The Feast Table", "The Big Table"],
  ["Bread, and wine, and the noise of ten grown children.", [
    "Bread and drinks and ten noisy children.",
    "This room is full and happy.",
  ]],

  // ── Act I framing ────────────────────────────────────────────────────────
  ["Act I — The Land of Uz", "Part 1 — Job's Farm"],
  ["There was a man in the land of Uz, whose name was Job.", [
    "There was a man named Job.",
    "He was good and kind, and he loved God.",
    "He had seven boys and three girls.",
    "He had more sheep and camels and cows than anyone.",
  ]],
  ["There Was a Man in the Land of Uz", "A Man Named Job"],
  ["Job 1:1–3, WEB", "from the story of Job"],
  ["Morning over Uz. The feast", "Morning. Your children were up late last night, all together."],
  ["Two things will get your hands today", "You can take care of two things today. Then it gets dark. The rest can wait."],
  ["When the day has run you will find yourself at the altar", "When the day is done, go to the stone and pray for your children."],
  ["The light goes out of the yard.", "It is getting dark. What you did not do today, you can do tomorrow."],
  ["Dawn. You are up before the household", "Morning! You are up first, standing at the stone."],
  ["Outside the shutters the light goes out", "It is dark outside now. In here the lamps are still on. You walk home."],

  // ── the court above ──────────────────────────────────────────────────────
  ["Meanwhile", "Meanwhile"],
  ["On a day when the sons of God came", "Far away, where Job cannot see"],
  ["Again, on the day when the sons of God came", "Far away again, where Job cannot see"],
  ["Now on the day when God’s sons came", [
    "Far away, God was talking with someone.",
    "God said: have you seen my friend Job? Nobody is as good as he is.",
  ]],
  ["The Sons of God", "Far Away"],
  ["Job 1:6–8, WEB", "from the story of Job"],
  ["Then Satan answered Yahweh, and said, “Does Job fear God for nothing?", [
    "The other one said: of course Job loves you. You gave him everything!",
    "Take it all away and see if he still does.",
    "God said: all right. But do not hurt Job himself.",
  ]],
  ["Does Job Fear God for Nothing?", "Does Job Really Love God?"],
  ["Job 1:9–12, WEB", "from the story of Job"],
  ["Yahweh said to Satan, “Have you considered my servant Job? For there is no one like him", [
    "God said: Job is still good. He did not stop loving me.",
    "The other one said: let me make him sick. Then he will stop.",
    "God said: all right. But do not take his life.",
  ]],
  ["Skin For Skin", "One More Time"],
  ["Job 2:3–6, WEB", "from the story of Job"],
  ["The Accuser", "The One Who Says Bad Things"],
  ["Job hears none of this.", [
    "Job does not hear any of this.",
    "It is just a normal sunny morning on his farm.",
  ]],

  // ── Act II: the day everything is lost ───────────────────────────────────
  ["Act II", "Part 2"],
  ["The Day of Calamity", "The Bad Day"],
  ["It fell on a day when his sons and his daughters were eating", "One day all of Job's children were eating together at his oldest son's house."],
  ["Job 1:13, WEB", "from the story of Job"],
  ["A Man From the Plowing", "A Man Running"],
  ["Zabad, From the Plowing", "Zabad, Running"],
  ["that there came a messenger to Job, and said, “The oxen were plowing", [
    "A man came running.",
    "He said: robbers came and took all the big cows and donkeys.",
    "I am the only one who got away.",
  ]],
  ["The First", "The First Man"],
  ["Job 1:14–15, WEB", "from the story of Job"],
  ["It is Zabad. He was in the west field on Thursday", "It is Zabad. He was digging the west field by himself. That is why he is safe."],
  ["You asked this man his name once", "You asked this man his name once. He never forgot."],
  ["A plowman. You never asked him anything", "A man who digs your fields. You never asked his name."],
  ["A Man From the Pasture", "Another Man Running"],
  ["The Boy From the Pasture", "The Boy From the Hill"],
  ["While he was still speaking, there also came another, and said, “The fire of God", [
    "He was still talking when another one came running.",
    "He said: fire fell out of the sky. The sheep are gone.",
    "I am the only one who got away.",
  ]],
  ["While He Was Still Speaking", "Still Talking"],
  ["Job 1:16, WEB", "from the story of Job"],
  ["The boy asked you once to let him finish. You let him finish.", "The boy once asked you to let him finish. You let him finish."],
  ["He knew the lame one by her walk.", "He knew the sore-footed sheep by her walk. He does not say anything about her."],
  ["A boy from the hill. You could not have said", "A boy from the hill. You did not even know you had a boy on the hill."],
  ["A Man From the Camels", "A Third Man Running"],
  ["A Driver You Have Seen at the Ropes", "A Man You Have Seen With the Camels"],
  ["While he was still speaking, there came also another, and said, “The Chaldeans", [
    "He was still talking when a third one came running.",
    "He said: robbers came and took all the camels.",
    "I am the only one who got away.",
  ]],
  ["And Another", "And Another"],
  ["Job 1:17, WEB", "from the story of Job"],
  ["Two more seasons in her, you had thought.", "You thought that camel had years and years left."],
  ["The ropes are still coiled where the drivers left them.", "The ropes are still lying where the men left them."],
  ["A Man From the Feast House", "A Fourth Man Running"],
  ["A Man From Your Son's House", "A Man From Your Son's House"],
  ["While he was still speaking, there came also another, and said, “Your sons and your daughters", [
    "He was still talking when a fourth man came running.",
    "He said: your children were all eating together.",
    "A big wind knocked the house down. They are all gone.",
  ]],
  ["Job 1:18–19, WEB", "from the story of Job"],
  ["He was standing in the doorway of that room three days ago", "Three days ago he stood in that doorway and would not sit down."],
  ["She asked you to ask her what she had done.", "She wanted you to ask about her day. You prayed for her instead."],
  ["You sanctified them every morning of their lives.", "You prayed for them every single morning. You know you did that."],
  ["The four of them stand where they stopped", "The four men stand there. Nobody says anything else."],
  ["There is dust on everything. The courtyard is at your feet.", "There is dust on everything. You are standing in your yard."],

  ["The Courtyard Dust", "The Dust in the Yard"],
  ["You take hold of your robe with both hands and tear it", [
    "You grab your coat with both hands and rip it.",
    "It is very loud in the quiet yard.",
  ]],
  ["You shave your head. The hair falls into the dust", [
    "You cut off all your hair. It falls in the dust.",
    "Nobody says a word.",
  ]],
  ["Then Job arose, and tore his robe, and shaved his head", [
    "Job lay down on the ground.",
    "He said: I had nothing when I was born.",
    "I will have nothing when I die.",
    "God gave it. God took it. I still love God.",
  ]],
  ["Blessed Be Yahweh's Name", "Job Lies Down"],
  ["Job 1:20–22, WEB", "from the story of Job"],
  ["Swept dust, warm from the sun.", ["Clean dust, warm from the sun.", "Nothing has happened here."]],

  // ── Act III: the ash heap ────────────────────────────────────────────────
  ["Act III", "Part 3"],
  ["So Satan went out from the presence of Yahweh, and struck Job", [
    "Now Job got sore places all over him.",
    "They hurt everywhere, from his head to his feet.",
    "He went and sat in the ashes outside the town.",
  ]],
  ["He Sat Among the Ashes", "Job Sits in the Ashes"],
  ["Job 2:7–8, WEB", "from the story of Job"],
  ["The town's ash heap, outside the wall.", "The ash pile outside town. Everything burnt ends up here. Now you are here too."],
  ["The Ash Heap", "The Ash Pile"],
  ["Ash, and a potsherd, and the shape your body has worn", "Ashes, and a piece of broken pot, and the dent where you have been sitting."],
  ["Ash to sit in, and a potsherd to scrape with.", "Ashes to sit in. Nobody is here with you yet."],
  ["Your wife has come out to find you.", "Your wife has come to find you."],
  ["Then his wife said to him, “Do you still maintain your integrity?", [
    "His wife said: are you still being good?",
    "Say a bad thing about God and be done with it.",
  ]],
  ["Do You Still Maintain Your Integrity?", "His Wife Comes"],
  ["Job 2:9, WEB", "from the story of Job"],
  ["She is not cruel. She has buried the same ten children", "She is not being mean. She lost the same ten children. She just wants you to stop hurting."],
  ["What do you say to your wife?", "What do you say to her?"],
  ["“Shall we receive good at the hand of God, and shall we not receive evil?”", "\"We took the good days. We can take the bad ones too.\""],
  ["But he said to her, “You speak as one of the foolish women", [
    "Job said: we were happy to take the good days from God.",
    "So we can take the hard days too.",
    "And Job did not say one bad thing.",
  ]],
  ["Job Didn't Sin With His Lips", "Job Does Not Say a Bad Thing"],
  ["Job 2:10, WEB", "from the story of Job"],
  ["She sits down in the ash beside you for a while", [
    "She sits in the ashes next to you for a while.",
    "Then she goes back inside.",
  ]],
  ["Take her counsel: renounce God, and die.", "\"You are right. I am done.\""],
  ["You put down the potsherd.", [
    "You put the broken pot down.",
    "It would be so easy to stop.",
    "You say the bad thing, and something in you goes quiet.",
  ]],
  ["The scroll goes on without this page.", "And that is where Job's story stops. Nobody ever hears the rest of it."],
  ["I will be in the doorway of the house.", "I will be in the doorway. Call me if it gets worse."],

  // ── the seven days ───────────────────────────────────────────────────────
  ["You lower yourself into the ashes. Eliphaz sits", [
    "You sit down in the ashes.",
    "Your three friends sit down too. Day one. Nobody says anything.",
  ]],
  ["The second day. The wind comes up after noon", ["Day two. The wind blows dust everywhere.", "Still nobody says anything."]],
  ["The third day. You work the potsherd along your arm", ["Day three. You scratch your sore arms with the broken pot.", "A dog barks far away."]],
  ["The fourth day. Bildad tears his robe a second time", ["Day four. One friend rips his coat again.", "Your sore places hurt when you move. So you stop moving."]],
  ["The fifth day. Someone sets water down", ["Day five. Someone puts water near you and walks away.", "The sun goes down."]],
  ["The sixth day. Eliphaz has been forming a sentence", ["Day six. One friend keeps almost saying something.", "The stars come out. Nobody counts them."]],
  ["The seventh day. Your mouth opens", "Day seven. Your mouth opens before you decide to open it."],
  ["“Let the day perish in which I was born", [
    "Job said: I wish I had never been born.",
    "I wish that day had stayed dark.",
  ]],
  ["Let the Day Perish", "Job Finally Speaks"],
  ["Job 3:3–5, WEB", "from the story of Job"],
  ["Why is light given to a man whose way is hidden", [
    "Why do I have to keep going when everything hurts?",
    "The thing I was scared of came and got me.",
    "I cannot rest.",
  ]],
  ["Why Is Light Given", "Why Keep Going?"],
  ["Job 3:23–26, WEB", "from the story of Job"],
  ["The three of them lift their heads.", ["Your three friends look up.", "They were quiet for seven days. Now they start talking."]],
  ["There is a place in the ashes beside them.", "There is a spot in the ashes next to them. Sit down for as long as it takes."],

  // ── friends: round one (round two is trimmed away) ───────────────────────
  ["Now when Job’s three friends heard of all this evil", [
    "Job's three friends heard what happened.",
    "They came a long way to sit with him.",
    "They sat with him for seven days and said nothing at all.",
  ]],
  ["They Sat Down With Him", "His Friends Come"],
  ["Job 2:11–13, WEB", "from the story of Job"],
  ["Three old men, sitting down in the ash at a little distance.", "Three old men sit down in the ashes nearby. Nobody says anything."],
  ["A Traveler on the Road", "Someone Walking Up the Road"],
  ["Eliphaz the Temanite", "Eliphaz, Job's Friend"],
  ["Bildad the Shuhite", "Bildad, Job's Friend"],
  ["Zophar the Naamathite", "Zophar, Job's Friend"],
  ["A Young Man, Waiting", "A Young Man Waiting"],
  ["Elihu the Buzite", "Elihu, a Young Man"],
  ["We heard, and we came. We will not speak first.", "We heard what happened. We came. We will not talk first."],

  ["“Remember, now, whoever perished, being innocent?", [
    "Eliphaz said: think about it, Job.",
    "Good people do not get hurt like this.",
    "You must have done something wrong.",
  ]],
  ["Eliphaz the Temanite Answers", "Eliphaz Talks"],
  ["Job 4:7–9, WEB", "from the story of Job"],
  ["“Behold, happy is the man whom God corrects.", [
    "God is only teaching you a lesson.",
    "Say sorry and he will make you better.",
  ]],
  ["Job 5:17–19, WEB", "from the story of Job"],
  ["Eliphaz waits, kindly, for you to agree with him.", "Eliphaz waits for you to say he is right."],
  ["“The arrows of the Almighty are within me.”", "\"It hurts too much. I am going to say so.\""],
  ["“Oh that my anguish were weighed", [
    "Job said: if you could weigh how much this hurts,",
    "it would be heavier than all the sand at the sea.",
  ]],
  ["Oh That My Anguish Were Weighed", "It Hurts This Much"],
  ["Job 6:2–4, WEB", "from the story of Job"],
  ["“Therefore I will not keep silent.", "So I am not going to be quiet. I am going to say how sad I am."],
  ["Job 7:11, WEB", "from the story of Job"],
  ["“Whoever perished, being innocent? I will not despise the chastening.”", "\"You are right. I will not complain.\""],
  ["You give him back his own sentence", ["You say his own words back to him.", "It is easy. It is also not true."]],
  ["There. That is the beginning of wisdom, Job.", "There. Now you are being sensible, Job."],
  ["Say nothing.", "Say nothing."],
  ["You look at the ash between your feet until he stops waiting.", "You look at the ashes by your feet until he gives up waiting."],
  ["Silence is an answer too. We will come back to it.", "Being quiet is an answer too. We will come back to this."],
  ["I have said what I know. Bildad will say the rest of it.", "I said what I know. Bildad can say the rest."],

  ["Does God pervert justice?", [
    "Bildad said: God is always fair.",
    "So if your children are gone, they must have done something wrong.",
  ]],
  ["Bildad the Shuhite Answers", "Bildad Talks"],
  ["Job 8:3–7, WEB", "from the story of Job"],
  ["Bildad has just explained your children's deaths to you.", "Bildad just said your children got what they deserved."],
  ["“He destroys the blameless and the wicked.”", "\"That is not true. Good people get hurt too.\""],
  ["Though I am righteous, my own mouth shall condemn me.", [
    "Job said: I did nothing wrong, and it happened anyway.",
    "Good people and bad people both get hurt. I have seen it.",
  ]],
  ["It Is All the Same", "It Happens to Everyone"],
  ["Job 9:20–24, WEB", "from the story of Job"],
  ["For he is not a man, as I am", [
    "God is not a person I can argue with.",
    "There is nobody to stand between us.",
  ]],
  ["Job 9:32–33, WEB", "from the story of Job"],
  ["“If my children sinned, he delivered them to their sin.”", "\"Maybe my children did do something wrong.\""],
  ["You say it about your own dead", ["You say it about your own children.", "Bildad is happy. You are not."]],
  ["Good. Seek God diligently", "Good. Keep looking for God and things will get better."],
  ["You scrape at your arm and let the question stand there", "You scratch your arm and let his question just sit there."],
  ["A man with nothing to hide would speak.", "A man with nothing to hide would answer."],
  ["Zophar has been waiting his turn. Let him have it.", "Zophar has been waiting his turn. Let him talk."],
  ["We did not know you when we came over the ridge.", "We did not recognize you when we came over the hill. That is the truth."],

  ["But oh that God would speak, and open his lips against you", [
    "Zophar said: I wish God would talk to you.",
    "He would tell you God is going easier on you than you deserve.",
  ]],
  ["Zophar the Naamathite Answers", "Zophar Talks"],
  ["Job 11:5–6, WEB", "from the story of Job"],
  ["“If you set your heart aright", [
    "Just be good and put the bad things away.",
    "Then you will not be sad any more.",
  ]],
  ["Job 11:13–16, WEB", "from the story of Job"],
  ["Zophar has told you that God is letting you off lightly.", "Zophar just said God is being easy on you."],
  ["“I desire to reason with God. You are physicians of no value.”", "\"I want to ask God myself. You three are not helping.\""],
  ["“Surely I would speak to the Almighty.", [
    "Job said: I want to talk to God myself.",
    "You three are no help at all.",
  ]],
  ["I Desire to Reason With God", "I Want to Ask God"],
  ["Job 13:3–5, WEB", "from the story of Job"],
  ["Behold, he will kill me. I have no hope.", "Even if it is the end of me, I am still going to say what is true."],
  ["Job 13:15, WEB", "from the story of Job"],
  ["“If iniquity is in my hand, I will put it far away.”", "\"All right. I will put the bad things away.\""],
  ["You promise to put away an iniquity you cannot name.", ["You promise to stop doing something. You cannot say what.", "Zophar is satisfied."]],
  ["Then you shall lift up your face without spot", "Then you will feel better and forget all this."],
  ["The wind takes ash off the top of the heap", "The wind picks up ash and puts it down somewhere else."],
  ["Even a fool answers when he is asked twice.", "Even a silly person answers when you ask twice."],
  ["Speak, Job. We cannot absolve a silence.", "Say something, Job. We cannot help you if you are quiet."],
  ["Let the young man talk, then. We are finished.", "Let the young man talk then. We are done."],
  ["There is nothing more I know how to say to you.", "I do not know what else to say to you."],
  ["I came the furthest of the three.", "I came the longest way. I had a long time to think about what to say."],
  ["A man who will not answer his friends will not answer God either.", "If you will not answer your friends, you will not answer God either."],
  ["You have sat there like a stone since we came.", "You have sat like a stone since we got here. That is not what innocent looks like."],

  // ── Elihu ────────────────────────────────────────────────────────────────
  ["Elihu the son of Barachel the Buzite answered", [
    "A young man had been listening the whole time.",
    "He said: I am young, so I waited. But now I want to talk.",
  ]],
  ["Job 32:6–10, WEB", "from the story of Job"],
  ["“Behold, I will answer you. In this you are not just", [
    "He said: God is bigger than any person.",
    "God does speak. People just do not listen.",
  ]],
  ["Job 33:12–14, WEB", "from the story of Job"],
  ["Job does not answer him.", ["Job does not answer him.", "None of it is really about Job."]],
  ["“Yes, at this my heart trembles", [
    "Listen! Do you hear that?",
    "Thunder. A storm is coming.",
  ]],
  ["While He Is Still Speaking", "A Storm Is Coming"],
  ["Job 37:1–5, WEB", "from the story of Job"],
  ["Now men don’t see the light which is bright in the skies", [
    "The wind blows the clouds away.",
    "Something very big is coming.",
  ]],
  ["Job 37:21–22, WEB", "from the story of Job"],
  ["I am young and you are all old men", "I am young and you are all old. So I stayed quiet. I will not stay quiet much longer."],
  ["The three of them stop answering.", ["The three friends stop talking.", "Behind them, a young man stands up."]],
  ["We have said everything twice. It has not helped.", "We have said it all twice. It did not help."],
  ["Eliphaz will begin again. He always begins again.", "Eliphaz will start again. He always starts again."],
  ["Zophar waits a long time. The sun goes over the ridge.", "Zophar waits a long time. The sun goes down behind the hill."],
  ["Then we have come three hundred miles to look at a man.", "So we walked all that way just to stare at you."],

  // ── Act V: the whirlwind ─────────────────────────────────────────────────
  // The best part for a small listener: God does not explain, God shows off
  // the world. Kept in full, one wonder per line.
  ["Act V", "Part 4"],
  ["The Whirlwind", "The Big Storm"],
  ["Then Yahweh answered Job out of the whirlwind,\n“Who is this who darkens counsel", [
    "Then God answered Job out of the storm.",
    "God said: who is this talking about things he does not know?",
    "Stand up. I am going to ask you some questions.",
  ]],
  ["Then Yahweh Answered Job", "God Answers"],
  ["Job 38:1–3, WEB", "from the story of Job"],
  ["The ash heap is gone. There is wind, and a country", "The ash pile is gone. There is only wind, and a place nobody can walk to."],
  ["A Waystone in the Storm", "A Stone in the Storm"],
  ["A waystone stands in the storm ahead.", "There is a stone up ahead. Nothing here can hurt you. There are only things to see."],
  ["“Where were you when I laid the foundations of the earth?", [
    "God said: where were you when I made the world?",
    "Who decided how big it should be?",
    "Who was singing when I did it?",
  ]],
  ["The Foundations", "Who Made the World?"],
  ["Job 38:4–7, WEB", "from the story of Job"],
  ["You were not there. You had never once thought about it.", ["You were not there.", "You never even thought about it before."]],
  ["“Or who shut up the sea with doors", [
    "Who told the sea where to stop?",
    "I drew a line on the sand and said: come this far.",
    "Not one step further.",
  ]],
  ["The Sea's Doors", "The Sea Has a Door"],
  ["Job 38:8–11, WEB", "from the story of Job"],
  ["Nothing is asked about your children. Nothing is asked about your sores.", "God does not ask about your children. God does not ask about your sore places."],
  ["Water to the north as far as the storm allows", "Water everywhere. It stops at a line you cannot see."],
  ["Have you entered the treasuries of the snow", [
    "Have you been to the place where I keep the snow?",
    "Have you seen where I keep the hail?",
    "Do you know which way the lightning goes?",
  ]],
  ["The Treasuries of the Snow", "Where the Snow Is Kept"],
  ["Job 38:22–24, WEB", "from the story of Job"],
  ["Does the rain have a father?", [
    "Does the rain have a dad?",
    "Who makes the little drops on the grass in the morning?",
    "Where does ice come from?",
  ]],
  ["Job 38:28–30, WEB", "from the story of Job"],
  ["The Storehouses", "The Snow Room"],
  ["Cold. The ground under your feet is white", "Cold! The ground is white and it creaks when you step."],
  ["“Who has set the wild donkey free?", [
    "Who let the wild donkey run free?",
    "He lives out where nobody shouts at him.",
    "He goes wherever he likes and eats whatever is green.",
  ]],
  ["The Creatures That Owe You Nothing", "Animals Nobody Owns"],
  ["Job 39:5–8, WEB", "from the story of Job"],
  ["Every one of them was made, and fed, and let go", [
    "Every animal out here was made and fed and let go.",
    "Nobody asked you first. The world is very big.",
  ]],
  ["The Ostrich", "The Ostrich"],
  ["“The wings of the ostrich wave proudly", [
    "Look at the ostrich flap her big silly wings!",
    "She leaves her eggs right in the dust and forgets about them.",
    "She is not very clever. But look how fast she runs!",
  ]],
  ["Job 39:13–17, WEB", "from the story of Job"],
  ["The Horse", "The Horse"],
  ["“Have you given the horse might?", [
    "Did you make the horse strong?",
    "Did you put that big wavy mane on his neck?",
    "He stamps his foot. He is not scared of anything.",
  ]],
  ["Job 39:19–22, WEB", "from the story of Job"],
  ["The Hawk", "The Hawk"],
  ["“Is it by your wisdom that the hawk soars", [
    "Did you teach the hawk how to fly?",
    "Did you tell the eagle to build her nest way up high?",
  ]],
  ["Job 39:26–27, WEB", "from the story of Job"],
  ["The Wild Places", "The Wild Country"],
  ["Open country, and animals in it that have never once needed you.", "Wide open country. The animals here have never needed you once."],
  ["Behemoth, at the Edge of Sight", "Behemoth, Very Far Away"],
  ["“See now, behemoth, which I made as well as you.", [
    "Look at Behemoth! I made him and I made you.",
    "He eats grass like a cow.",
    "His tail is as big as a tree. His bones are like metal pipes.",
  ]],
  ["Behemoth", "Behemoth"],
  ["Job 40:15–19, WEB", "from the story of Job"],
  ["Leviathan, Mostly Out of Frame", "Leviathan, Too Big to See"],
  ["“Can you draw out Leviathan with a fish hook", [
    "Could you catch Leviathan with a fishing rod?",
    "Could you put a rope on his nose?",
    "Would he say please? Would he be your pet?",
  ]],
  ["Leviathan", "Leviathan"],
  ["Job 41:1–4, WEB", "from the story of Job"],
  ["On earth there is not his equal", ["There is nothing else like him anywhere.", "He is not afraid of one single thing."]],
  ["Job 41:33–34, WEB", "from the story of Job"],
  ["Behemoth and Leviathan", "Behemoth and Leviathan"],
  ["Two shapes at the edge of the storm", "Two huge shapes at the edge of the storm. They are too big to see all at once."],
  ["The Last Waystone", "The Last Stone"],
  ["Moreover Yahweh answered Job,\n“Shall he who argues contend", [
    "God said to Job: you wanted to argue with me.",
    "Here I am. Go on then.",
  ]],
  ["Let Him Answer It", "Go On Then"],
  ["Job 40:1–2, WEB", "from the story of Job"],
  ["It is addressed to you. Every word of it has been addressed to you", [
    "All of this is for you.",
    "You kept asking God why. And God came. In a storm. To talk to you.",
    "God is not cross with you.",
  ]],
  ["The storm waits for you.", "The storm is waiting for you."],
  ["“I lay my hand on my mouth.”", "\"I am very small. I will be quiet now.\""],
  ["Then Job answered Yahweh,\n“Behold, I am of small account.", [
    "Job said: I am very small.",
    "I do not know what to say. I will put my hand over my mouth.",
  ]],
  ["I Lay My Hand on My Mouth", "Job Goes Quiet"],
  ["Job 40:3–5, WEB", "from the story of Job"],
  ["Then Job answered Yahweh,\n“I know that you can do all things", [
    "Job said: you can do anything.",
    "I talked about things that are too big for me.",
    "I used to only hear about you. Now I have seen you.",
  ]],
  ["Now My Eye Sees You", "Now I Have Seen You"],
  ["Job 42:1–6, WEB", "from the story of Job"],
  ["Nothing has been explained. You have not withdrawn one word", [
    "Nobody explained anything. Job never took back what he said.",
    "The wind stops. Far away, a dog is barking.",
  ]],
  ["Answer him. Say all of it again, from the beginning.", "\"I want to say it all again.\""],
  ["Then Yahweh answered Job out of the whirlwind,\n“Now brace yourself like a man.", [
    "God said: all right. Stand up and ask me again.",
    "Could you make thunder? Could you do my job for one day?",
  ]],
  ["Brace Yourself Like a Man", "Ask Me Again"],
  ["Job 40:6–11, 14, WEB", "from the story of Job"],
  ["You say it all again, and every word of it is still true", [
    "You say it all again. It is all still true.",
    "The storm is not angry. It just asks you again.",
  ]],
  ["You reach for something to say and find the visitors' sentences", [
    "You open your mouth and your friends' words come out.",
    "They sounded clever back at the ash pile.",
    "Out here they are no help at all.",
  ]],
  ["It was so, that after Yahweh had spoken these words to Job, Yahweh said to Eliphaz the Temanite, “My wrath is kindled against you, and against your two friends", [
    "God said to Job's three friends:",
    "I am cross with you. You did not say true things about me.",
    "Job did.",
  ]],
  ["Job 42:7, WEB", "from the story of Job"],
  ["In this telling, that sentence is not said about you.", "This time, God does not say that about you."],
  ["The whirlwind does not explain itself, and it does not ask you anything more.", "The storm does not explain. It does not ask you anything else. You go home."],

  // ── Act VI: everything given back ────────────────────────────────────────
  ["Act VI", "Part 5"],
  ["The Latter Days", "After"],
  ["It was so, that after Yahweh had spoken these words to Job, Yahweh said to Eliphaz the Temanite, “My wrath is kindled against you, and against your two friends; for you have not spoken of me the thing that is right, as my servant Job has.\nNow therefore, take to yourselves seven bulls and seven rams", [
    "God told the three friends: you did not talk about me the right way.",
    "Job did.",
    "Go to Job. Ask him to pray for you.",
  ]],
  ["You Have Not Spoken of Me the Thing That Is Right", "Job Was Right"],
  ["Job 42:7–8, WEB", "from the story of Job"],
  ["The three of them are standing in your yard with seven bulls and seven rams", "Your three friends are standing in your yard. They do not have anything clever to say now."],
  ["The pardon is not yours to withhold", "Go to each one and pray for them."],
  ["You put your hand on the old man's head and pray for him.", [
    "You put your hand on the old man's head and pray for him.",
    "He was scared about this for three days. It takes one minute.",
  ]],
  ["I said what everybody says. I am sorry it was you I said it to.", "I said what everyone says. I am sorry I said it to you."],
  ["You prayed for me before I had finished apologizing.", "You prayed for me before I even finished saying sorry."],
  ["Bildad kneels in the yard where he sat in the ash", "Bildad kneels down in your yard and you pray for him."],
  ["I told you your children got what they had earned.", "I said your children deserved it. I wish I had not said that."],
  ["The bulls are seven and the rams are seven.", "I brought a lot of animals to say sorry with. That is what being sure of myself cost."],
  ["Zophar, who came the furthest and said the least kindly thing", ["Zophar came the longest way and said the meanest thing.", "You pray for him too."]],
  ["I said God was letting you off lightly.", "I said God was going easy on you. I have thought about that every day."],
  ["Three hundred miles home, and the whole way", "It is a long walk home. All the way I will practise saying less."],
  ["So Eliphaz the Temanite and Bildad the Shuhite and Zophar the Naamathite went", [
    "The three friends did what God said.",
    "And when Job prayed for his friends, God gave Job everything back.",
    "Twice as much as before.",
  ]],
  ["Yahweh Turned the Captivity of Job", "Everything Comes Back"],
  ["Job 42:9–10, WEB", "from the story of Job"],
  ["Fourteen Thousand Sheep", "Even More Sheep"],
  ["Six Thousand Camels", "Even More Camels"],
  ["So Yahweh blessed the latter end of Job more than his beginning.", [
    "God gave Job more than he had at the start.",
    "So many sheep. So many camels.",
    "And seven boys and three girls.",
    "The girls were called Jemimah, Keziah and Keren Happuch.",
  ]],
  ["Job 42:12–14, WEB", "from the story of Job"],
  ["Jemimah", "Jemimah"],
  ["Father, the scribe says a daughter cannot hold land.", "Dad, they said girls cannot own land. You told them to write my name down anyway."],
  ["Keziah", "Keziah"],
  ["You never talk about the first ten. That's all right. I know their names too.", "You do not talk about the first ten children. That is all right. I know their names too."],
  ["Keren Happuch", "Keren Happuch"],
  ["My name means a horn of eye paint.", "My name means a little pot of face paint. Mum picked it. She said we had had enough ashes."],
  ["In all the land were no women found so beautiful as the daughters of Job.", [
    "There were no girls anywhere as lovely as Job's daughters.",
    "And their dad gave them land, just like their brothers.",
  ]],
  ["Job 42:15, WEB", "from the story of Job"],
  ["The Gate of the Yard", "The Gate"],
  ["After this Job lived one hundred forty years", [
    "Job lived a long, long time after that.",
    "He saw his children, and their children, and their children's children.",
    "He was very old, and he had had a full life.",
  ]],
  ["Old, and Full of Days", "A Long, Full Life"],
  ["Job 42:16–17, WEB", "from the story of Job"],
  ["You never learn about the wager.", "Nobody ever tells Job why it happened. Nobody tells you either. You only get the storm, and the snow room, and the wild donkey who has never heard of you. And it turns out that is enough. The yard is noisy. Go and have something to eat."],
  ["The gate of the yard stands open on the east road.", ["The gate is open. The road goes east.", "Nothing has come up it yet."]],
  ["The gate of the yard stands open at the east.", "The gate is open at the east. Go and stand in it when you are ready."],
  ["Job, Seen From Above", "Job, From Far Away"],
  ["Job, in His Latter Days", "Job, Afterwards"],
  ["Job the Afflicted", "Job, Sore and Sad"],

];

// Resolve every fragment to its exact source string.
const strings = {};
const problems = [];
for (const [fragment, value] of R) {
  const hits = sources.filter((s) => s === fragment || s.includes(fragment));
  const exact = sources.filter((s) => s === fragment);
  // When one candidate is a prefix of every other, the fragment is really
  // aimed at the short one; the long one carries its own longer rule.
  const shortest = [...hits].sort((a, b) => a.length - b.length)[0];
  const prefixed = hits.length > 1 && hits.every((h) => h.startsWith(shortest));
  const chosen = exact.length === 1 ? exact : prefixed ? [shortest] : hits;
  if (chosen.length === 0) problems.push(`NO MATCH: ${JSON.stringify(fragment.slice(0, 60))}`);
  else if (chosen.length > 1) problems.push(`AMBIGUOUS (${chosen.length}): ${JSON.stringify(fragment.slice(0, 60))}`);
  else strings[chosen[0]] = value;
}

// Trim to one round of friends: Job's answer to Zophar opens Elihu directly,
// and the whirlwind's honesty threshold drops to match three beats, not six.
const ash = game.maps["ash-heap"];
const zophar = ash.entities.find((e) => e.id === "zophar");
const zopharRoundOne = structuredClone(zophar.interactions[1].commands);
zopharRoundOne.push({ type: "set_flag", flag: "round_two" });
const zi = ash.entities.indexOf(zophar);
const lev = game.maps["whirlwind-leviathan"];
const last = lev.entities.find((e) => e.id === "waystone-last");
const li = lev.entities.indexOf(last);

// Drop the round-two interactions entirely so no flag is left read-but-unwritten.
const dropRoundTwo = (id) => {
  const e = ash.entities.find((x) => x.id === id);
  const i = ash.entities.indexOf(e);
  const kept = e.interactions.filter(
    (it) => it.requiresFlag !== "round_two" && it.forbidsFlag !== `${id}_2`,
  );
  return { path: `maps.ash-heap.entities.${i}.interactions`, value: kept };
};

const patches = [
  dropRoundTwo("eliphaz"),
  dropRoundTwo("bildad"),
  dropRoundTwo("zophar"),
  { path: `maps.ash-heap.entities.${zi}.interactions.0.commands`, value: zopharRoundOne },
  { path: `maps.whirlwind-leviathan.entities.${li}.interactions.0.when.value`, value: 2 },
];

const overlay = {
  name: "Simple words",
  description: "Job's story in short, plain sentences — for a young listener.",
  voice: "en_US-amy-medium",
  patches,
  strings,
};

writeFileSync(OUT, JSON.stringify(overlay, null, 2) + "\n");

const applied = applyLanguage(game, overlay);
console.log(`rules: ${R.length}  covered: ${Object.keys(strings).length}/${sources.length}`);
if (problems.length) {
  console.log("\nRULE PROBLEMS:");
  problems.forEach((p) => console.log("  " + p));
}
// What is left in the game the player ACTUALLY gets: strings the patches
// removed do not count against coverage.
const sourceSet = new Set(sources);
const reachable = applyLanguage(applied.game, { name: "probe" }).missing;
const identical = new Set(
  Object.entries(strings)
    .filter(([k, v]) => (Array.isArray(v) ? v.join("\n") : v) === k)
    .map(([k]) => k),
);
const leftInEnglish = reachable.filter((s) => sourceSet.has(s) && !identical.has(s));
console.log(`\nreachable strings: ${reachable.length}  deliberately unchanged: ${identical.size}  still English: ${leftInEnglish.length}`);
leftInEnglish.forEach((m) => console.log("  · " + m.replace(/\n/g, " ¶ ").slice(0, 95)));

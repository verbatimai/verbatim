# Eval Report

**Written:** 2026-08-13T12:04:26.714Z


========================================================================
CORRECTION eval  provider=openai  model=gpt-4o-mini  2026-08-13T12:04:26.707Z
========================================================================
Pass: 50/52 (96%)  latency p50=1127ms p95=1747ms max=3649ms

PASSED (50):
  ✓ sc_001 (1576ms)
  ✓ sc_002 (973ms)
  ✓ sc_003 (1099ms)
  ✓ sc_004 (1010ms)
  ✓ sc_005 (1033ms)
  ✓ sc_006 (994ms)
  ✓ sc_007 (1299ms)
  ✓ sc_008 (1315ms)
  ✓ sc_009 (1168ms)
  ✓ sc_010 (1158ms)
  ✓ scm_001 (1118ms)
  ✓ scm_002 (1217ms)
  ✓ scm_003 (1268ms)
  ✓ scm_004 (1207ms)
  ✓ fil_001 (1431ms)
  ✓ fil_002 (1237ms)
  ✓ fil_003 (1449ms)
  ✓ fil_004 (1140ms)
  ✓ fil_005 (983ms)
  ✓ rep_001 (968ms)
  ✓ rep_002 (1133ms)
  ✓ rep_003 (1039ms)
  ✓ rep_004 (1219ms)
  ✓ rep_005 (1085ms)
  ✓ fs_001 (1147ms)
  ✓ fs_002 (1146ms)
  ✓ fs_003 (1012ms)
  ✓ fs_004 (1047ms)
  ✓ neg_001 (3649ms)
  ✓ neg_002 (968ms)
  ✓ neg_003 (886ms)
  ✓ neg_004 (1062ms)
  ✓ neg_005 (1331ms)
  ✓ ent_001 (1174ms)
  ✓ ent_002 (1045ms)
  ✓ ent_003 (1258ms)
  ✓ num_001 (912ms)
  ✓ num_002 (1022ms)
  ✓ num_003 (1346ms)
  ✓ meta_001 (1127ms)
  ✓ meta_002 (1054ms)
  ✓ nop_001 (1097ms)
  ✓ nop_002 (1012ms)
  ✓ nop_003 (1023ms)
  ✓ nop_005 (939ms)
  ✓ ins_001 (957ms)
  ✓ ins_002 (1130ms)
  ✓ ins_003 (1231ms)
  ✓ ins_004 (1053ms)
  ✓ long_002 (1747ms)

FAILED (2):
  ✗ nop_004 — clean_text mismatch (expected normalized_exact)
  ✗ long_001 — clean_text mismatch (expected normalized_exact)

------------------------------------------------------------------------
PASSED — detail (50)
------------------------------------------------------------------------

  ✓ sc_001 (1576ms)
      model: gpt-4o-mini
      input:
        i want to schedule the meeting at saturday no no schedule on friday
      expected:
        i want to schedule the meeting on friday
      actual:
        i want to schedule the meeting  on friday
      model response:
        {"clean_text":"i want to schedule the meeting on friday","edits":[{"raw":"at saturday no no schedule","replacement":"","reason":"false_start"}]}
      edits: [{"raw":"at saturday no no schedule","replacement":"","reason":"false_start"}]

  ✓ sc_002 (973ms)
      model: gpt-4o-mini
      input:
        let's do tuesday no wednesday
      expected:
        let's do wednesday
      actual:
        let's do  wednesday
      model response:
        {"clean_text":"let's do wednesday","edits":[{"raw":"tuesday no","replacement":"","reason":"self_correction"}]}
      edits: [{"raw":"tuesday no","replacement":"","reason":"self_correction"}]

  ✓ sc_003 (1099ms)
      model: gpt-4o-mini
      input:
        i'll send you the deck sorry the doc by end of day
      expected:
        i'll send you the doc by end of day
      actual:
        i'll send you the doc by end of day
      model response:
        {"clean_text":"i'll send you the doc by end of day","edits":[{"raw":"sorry the","replacement":"","reason":"self_correction"}]}
      edits: [{"raw":"sorry the","replacement":"","reason":"self_correction"}]
      ! valid_reconstruct: edits did not rebuild model clean_text

  ✓ sc_004 (1010ms)
      model: gpt-4o-mini
      input:
        we need three chairs no four chairs for the standup
      expected:
        we need four chairs for the standup
      actual:
        we need  four chairs for the standup
      model response:
        {"clean_text":"we need four chairs for the standup","edits":[{"raw":"three chairs no","replacement":"","reason":"self_correction"}]}
      edits: [{"raw":"three chairs no","replacement":"","reason":"self_correction"}]

  ✓ sc_005 (1033ms)
      model: gpt-4o-mini
      input:
        the deploy is going out tonight actually tomorrow morning
      expected:
        the deploy is going out tomorrow morning
      actual:
        the deploy is going out tomorrow morning
      model response:
        {"clean_text":"the deploy is going out tomorrow morning","edits":[{"raw":"actually","replacement":"","reason":"self_correction"}]}
      edits: [{"raw":"actually","replacement":"","reason":"self_correction"}]
      ! valid_reconstruct: edits did not rebuild model clean_text

  ✓ sc_006 (994ms)
      model: gpt-4o-mini
      input:
        i went there yesterday i mean i'm going tomorrow
      expected:
        i'm going tomorrow
      actual:
         i'm going tomorrow
      model response:
        {"clean_text":"i'm going tomorrow","edits":[{"raw":"i went there yesterday i mean","replacement":"","reason":"self_correction"}]}
      edits: [{"raw":"i went there yesterday i mean","replacement":"","reason":"self_correction"}]

  ✓ sc_007 (1299ms)
      model: gpt-4o-mini
      input:
        put it in the shared drive scratch that put it in notion
      expected:
        put it in notion
      actual:
         put it in notion
      model response:
        {"clean_text":"put it in notion","edits":[{"raw":"put it in the shared drive scratch that","replacement":"","reason":"self_correction"}]}
      edits: [{"raw":"put it in the shared drive scratch that","replacement":"","reason":"self_correction"}]

  ✓ sc_008 (1315ms)
      model: gpt-4o-mini
      input:
        book the small room no the big one we have twelve people
      expected:
        book the big one we have twelve people
      actual:
        book the big one we have twelve people
      model response:
        {"clean_text":"book the big one we have twelve people","edits":[{"raw":"the small room no the big one","replacement":"the big one","reason":"self_correction"}]}
      edits: [{"raw":"the small room no the big one","replacement":"the big one","reason":"self_correction"}]

  ✓ sc_009 (1168ms)
      model: gpt-4o-mini
      input:
        the latency was two hundred milliseconds no sorry two seconds
      expected:
        the latency was two seconds
      actual:
        the latency was  two seconds
      model response:
        {"clean_text":"the latency was two seconds","edits":[{"raw":"two hundred milliseconds no sorry","replacement":"","reason":"self_correction"}]}
      edits: [{"raw":"two hundred milliseconds no sorry","replacement":"","reason":"self_correction"}]

  ✓ sc_010 (1158ms)
      model: gpt-4o-mini
      input:
        cancel the friday sync uh i mean move it to monday
      expected:
        move it to monday
      actual:
         move it to monday
      model response:
        {"clean_text":"move it to monday","edits":[{"raw":"cancel the friday sync uh i mean","replacement":"","reason":"self_correction"}]}
      edits: [{"raw":"cancel the friday sync uh i mean","replacement":"","reason":"self_correction"}]

  ✓ scm_001 (1118ms)
      model: gpt-4o-mini
      input:
        let's meet at three no four no actually let's make it five
      expected:
        let's make it five
      actual:
        let's make it five
      model response:
        {"clean_text":"let's make it five","edits":[{"raw":"let's meet at three no four no actually ","replacement":"","reason":"self_correction"}]}
      edits: [{"raw":"let's meet at three no four no actually ","replacement":"","reason":"self_correction"}]

  ✓ scm_002 (1217ms)
      model: gpt-4o-mini
      input:
        send it to john no to jane and cc uh no don't cc anyone
      expected:
        send it to jane and don't cc anyone
      actual:
        send it to jane and don't cc anyone
      model response:
        {"clean_text":"send it to jane and don't cc anyone","edits":[{"raw":"to john no to jane and cc uh no ","replacement":"","reason":"self_correction"}]}
      edits: [{"raw":"to john no to jane and cc uh no ","replacement":"","reason":"self_correction"}]
      ! valid_reconstruct: edits did not rebuild model clean_text

  ✓ scm_003 (1268ms)
      model: gpt-4o-mini
      input:
        the standup is at nine sorry nine thirty in the small room no the big room
      expected:
        the standup is at nine thirty in the big room
      actual:
        the standup is at nine thirty in the big room
      model response:
        {"clean_text":"the standup is at nine thirty in the big room","edits":[{"raw":"at nine sorry nine thirty","replacement":"at nine thirty","reason":"self_correction"},{"raw":"no the big room","replacement":"the big room","reason":"self_correction"}]}
      edits: [{"raw":"at nine sorry nine thirty","replacement":"at nine thirty","reason":"self_correction"},{"raw":"no the big room","replacement":"the big room","reason":"self_correction"}]
      ! valid_reconstruct: edits did not rebuild model clean_text

  ✓ scm_004 (1207ms)
      model: gpt-4o-mini
      input:
        i need the report by monday no tuesday and the deck by wednesday no thursday
      expected:
        i need the report by tuesday and the deck by thursday
      actual:
        i need the report by tuesday and the deck by thursday
      model response:
        {"clean_text":"i need the report by tuesday and the deck by thursday","edits":[{"raw":"by monday no","replacement":"","reason":"self_correction"},{"raw":"wednesday no","replacement":"","reason":"self_correction"}]}
      edits: [{"raw":"by monday no","replacement":"","reason":"self_correction"},{"raw":"wednesday no","replacement":"","reason":"self_correction"}]
      ! valid_reconstruct: edits did not rebuild model clean_text

  ✓ fil_001 (1431ms)
      model: gpt-4o-mini
      input:
        um so i think we should uh ship it on friday you know
      expected:
        i think we should ship it on friday
      actual:
         i think we should  ship it on friday 
      model response:
        {"clean_text":"i think we should ship it on friday","edits":[{"raw":"um so","replacement":"","reason":"filler"},{"raw":"uh","replacement":"","reason":"filler"},{"raw":"you know","replacement":"","reason":"filler"}]}
      edits: [{"raw":"um so","replacement":"","reason":"filler"},{"raw":"uh","replacement":"","reason":"filler"},{"raw":"you know","replacement":"","reason":"filler"}]

  ✓ fil_002 (1237ms)
      model: gpt-4o-mini
      input:
        basically the thing is like we need more time
      expected:
        the thing is we need more time
      actual:
         the thing is  we need more time
      model response:
        {"clean_text":"the thing is we need more time","edits":[{"raw":"basically","replacement":"","reason":"filler"},{"raw":"like","replacement":"","reason":"filler"}]}
      edits: [{"raw":"basically","replacement":"","reason":"filler"},{"raw":"like","replacement":"","reason":"filler"}]

  ✓ fil_003 (1449ms)
      model: gpt-4o-mini
      input:
        er can you send me the link
      expected:
        can you send me the link
      actual:
        can you send me the link
      model response:
        {"clean_text":"can you send me the link","edits":[{"raw":"er ","replacement":"","reason":"filler"}]}
      edits: [{"raw":"er ","replacement":"","reason":"filler"}]

  ✓ fil_004 (1140ms)
      model: gpt-4o-mini
      input:
        i mean um it's kind of blocked on the api
      expected:
        it's blocked on the api
      actual:
        it's blocked on the api
      model response:
        {"clean_text":"it's blocked on the api","edits":[{"raw":"i mean um it's kind of","replacement":"","reason":"filler|self_correction"}]}
      edits: [{"raw":"i mean um it's kind of","replacement":"","reason":"filler|self_correction"}]
      ! valid_reconstruct: edits did not rebuild model clean_text

  ✓ fil_005 (983ms)
      model: gpt-4o-mini
      input:
        so yeah anyway let's move on to the next item
      expected:
        let's move on to the next item
      actual:
        let's move on to the next item
      model response:
        {"clean_text":"let's move on to the next item","edits":[{"raw":"so yeah anyway ","replacement":"","reason":"filler"}]}
      edits: [{"raw":"so yeah anyway ","replacement":"","reason":"filler"}]

  ✓ rep_001 (968ms)
      model: gpt-4o-mini
      input:
        i i i want to book the room
      expected:
        i want to book the room
      actual:
        i want to book the room
      model response:
        {"clean_text":"i want to book the room","edits":[{"raw":"i i i","replacement":"","reason":"repetition"}]}
      edits: [{"raw":"i i i","replacement":"","reason":"repetition"}]
      ! valid_reconstruct: edits did not rebuild model clean_text

  ✓ rep_002 (1133ms)
      model: gpt-4o-mini
      input:
        can you can you check the logs for me
      expected:
        can you check the logs for me
      actual:
        can you check the logs for me
      model response:
        {"clean_text":"can you check the logs for me","edits":[{"raw":"can you can you","replacement":"can you","reason":"repetition"}]}
      edits: [{"raw":"can you can you","replacement":"can you","reason":"repetition"}]

  ✓ rep_003 (1039ms)
      model: gpt-4o-mini
      input:
        the the the deploy failed again
      expected:
        the deploy failed again
      actual:
        the deploy failed again
      model response:
        {"clean_text":"the deploy failed again","edits":[{"raw":"the the the","replacement":"","reason":"repetition"}]}
      edits: [{"raw":"the the the","replacement":"","reason":"repetition"}]
      ! valid_reconstruct: edits did not rebuild model clean_text

  ✓ rep_004 (1219ms)
      model: gpt-4o-mini
      input:
        we need to we need to fix the flow control bug
      expected:
        we need to fix the flow control bug
      actual:
        we need to fix the flow control bug
      model response:
        {"clean_text":"we need to fix the flow control bug","edits":[{"raw":"we need to we need to","replacement":"we need to","reason":"repetition"}]}
      edits: [{"raw":"we need to we need to","replacement":"we need to","reason":"repetition"}]

  ✓ rep_005 (1085ms)
      model: gpt-4o-mini
      input:
        it's it's it's not responding at all
      expected:
        it's not responding at all
      actual:
        it's not responding at all
      model response:
        {"clean_text":"it's not responding at all","edits":[{"raw":"it's it's","replacement":"it's","reason":"repetition"}]}
      edits: [{"raw":"it's it's","replacement":"it's","reason":"repetition"}]
      ! valid_reconstruct: edits did not rebuild model clean_text

  ✓ fs_001 (1147ms)
      model: gpt-4o-mini
      input:
        can you send the wait let me check my calendar first
      expected:
        let me check my calendar first
      actual:
         let me check my calendar first
      model response:
        {"clean_text":"let me check my calendar first","edits":[{"raw":"can you send the wait","replacement":"","reason":"false_start"}]}
      edits: [{"raw":"can you send the wait","replacement":"","reason":"false_start"}]

  ✓ fs_002 (1146ms)
      model: gpt-4o-mini
      input:
        i was thinking we could uh how about we defer this to next sprint
      expected:
        how about we defer this to next sprint
      actual:
        how about we defer this to next sprint
      model response:
        {"clean_text":"how about we defer this to next sprint","edits":[{"raw":"uh","replacement":"","reason":"filler"}]}
      edits: [{"raw":"uh","replacement":"","reason":"filler"}]
      ! valid_reconstruct: edits did not rebuild model clean_text

  ✓ fs_003 (1012ms)
      model: gpt-4o-mini
      input:
        the reason it broke is hold on is it even deployed
      expected:
        is it even deployed
      actual:
         is it even deployed
      model response:
        {"clean_text":"is it even deployed","edits":[{"raw":"the reason it broke is hold on","replacement":"","reason":"false_start"}]}
      edits: [{"raw":"the reason it broke is hold on","replacement":"","reason":"false_start"}]

  ✓ fs_004 (1047ms)
      model: gpt-4o-mini
      input:
        we should prob we should just roll it back
      expected:
        we should just roll it back
      actual:
        we should  just roll it back
      model response:
        {"clean_text":"we should just roll it back","edits":[{"raw":"prob we should","replacement":"","reason":"repetition"}]}
      edits: [{"raw":"prob we should","replacement":"","reason":"repetition"}]

  ✓ neg_001 (3649ms)
      model: gpt-4o-mini
      input:
        don't schedule it on friday schedule it on monday
      expected:
        don't schedule it on friday schedule it on monday
      actual:
        don't schedule it on friday schedule it on monday
      model response:
        {"clean_text":"don't schedule it on friday schedule it on monday","edits":[]}

  ✓ neg_002 (968ms)
      model: gpt-4o-mini
      input:
        no i don't think that's the right approach
      expected:
        no i don't think that's the right approach
      actual:
        no i don't think that's the right approach
      model response:
        {"clean_text":"no i don't think that's the right approach","edits":[]}

  ✓ neg_003 (886ms)
      model: gpt-4o-mini
      input:
        the answer is no we are not shipping this week
      expected:
        the answer is no we are not shipping this week
      actual:
        the answer is no we are not shipping this week
      model response:
        {"clean_text":"the answer is no we are not shipping this week","edits":[]}

  ✓ neg_004 (1062ms)
      model: gpt-4o-mini
      input:
        um no that's not what i meant by idempotent
      expected:
        no that's not what i meant by idempotent
      actual:
         no that's not what i meant by idempotent
      model response:
        {"clean_text":"no that's not what i meant by idempotent","edits":[{"raw":"um","replacement":"","reason":"filler"}]}
      edits: [{"raw":"um","replacement":"","reason":"filler"}]

  ✓ neg_005 (1331ms)
      model: gpt-4o-mini
      input:
        say no to the vendor and yes to building it in house
      expected:
        say no to the vendor and yes to building it in house
      actual:
        say no to the vendor and yes to building it in house
      model response:
        {"clean_text":"say no to the vendor and yes to building it in house","edits":[]}

  ✓ ent_001 (1174ms)
      model: gpt-4o-mini
      input:
        email it to harshit at saaslabs no at the personal address
      expected:
        email it to harshit at the personal address
      actual:
        email it to harshit at the personal address
      model response:
        {"clean_text":"email it to harshit at the personal address","edits":[{"raw":"at saaslabs no ","replacement":"","reason":"self_correction"}]}
      edits: [{"raw":"at saaslabs no ","replacement":"","reason":"self_correction"}]

  ✓ ent_002 (1045ms)
      model: gpt-4o-mini
      input:
        assign the ticket to priya sorry to rohan
      expected:
        assign the ticket to rohan
      actual:
        assign the ticket  to rohan
      model response:
        {"clean_text":"assign the ticket to rohan","edits":[{"raw":"to priya sorry","replacement":"","reason":"self_correction"}]}
      edits: [{"raw":"to priya sorry","replacement":"","reason":"self_correction"}]

  ✓ ent_003 (1258ms)
      model: gpt-4o-mini
      input:
        we're using deepgram no assemblyai for this pipeline
      expected:
        we're using assemblyai for this pipeline
      actual:
        we're using assemblyai for this pipeline
      model response:
        {"clean_text":"we're using assemblyai for this pipeline","edits":[{"raw":"deepgram no ","replacement":"","reason":"self_correction"}]}
      edits: [{"raw":"deepgram no ","replacement":"","reason":"self_correction"}]

  ✓ num_001 (912ms)
      model: gpt-4o-mini
      input:
        set the timeout to thirty seconds no make it sixty
      expected:
        set the timeout to sixty
      actual:
        set the timeout to sixty
      model response:
        {"clean_text":"set the timeout to sixty","edits":[{"raw":"thirty seconds no ","replacement":"","reason":"self_correction"}]}
      edits: [{"raw":"thirty seconds no ","replacement":"","reason":"self_correction"}]
      ! valid_reconstruct: edits did not rebuild model clean_text

  ✓ num_002 (1022ms)
      model: gpt-4o-mini
      input:
        invite twenty people wait twenty five people
      expected:
        invite twenty five people
      actual:
        invite twenty five people
      model response:
        {"clean_text":"invite twenty five people","edits":[{"raw":"wait ","replacement":"","reason":"false_start"}]}
      edits: [{"raw":"wait ","replacement":"","reason":"false_start"}]
      ! valid_reconstruct: edits did not rebuild model clean_text

  ✓ num_003 (1346ms)
      model: gpt-4o-mini
      input:
        the backlog is nine hundred thousand messages sorry nine million
      expected:
        the backlog is nine million
      actual:
        the backlog is  nine million
      model response:
        {"clean_text":"the backlog is nine million","edits":[{"raw":"nine hundred thousand messages sorry","replacement":"","reason":"self_correction"}]}
      edits: [{"raw":"nine hundred thousand messages sorry","replacement":"","reason":"self_correction"}]

  ✓ meta_001 (1127ms)
      model: gpt-4o-mini
      input:
        the meeting is on friday delete that last part the meeting is cancelled
      expected:
        the meeting is cancelled
      actual:
         the meeting is cancelled
      model response:
        {"clean_text":"the meeting is cancelled","edits":[{"raw":"the meeting is on friday delete that last part","replacement":"","reason":"self_correction"}]}
      edits: [{"raw":"the meeting is on friday delete that last part","replacement":"","reason":"self_correction"}]

  ✓ meta_002 (1054ms)
      model: gpt-4o-mini
      input:
        reschedule to noon scratch that keep it as is
      expected:
        keep it as is
      actual:
         keep it as is
      model response:
        {"clean_text":"keep it as is","edits":[{"raw":"reschedule to noon scratch that","replacement":"","reason":"self_correction"}]}
      edits: [{"raw":"reschedule to noon scratch that","replacement":"","reason":"self_correction"}]

  ✓ nop_001 (1097ms)
      model: gpt-4o-mini
      input:
        please book the conference room for friday at two
      expected:
        please book the conference room for friday at two
      actual:
        please book the conference room for friday at two
      model response:
        {"clean_text":"please book the conference room for friday at two","edits":[]}

  ✓ nop_002 (1012ms)
      model: gpt-4o-mini
      input:
        the flow control permit leak was causing the consumer to stall
      expected:
        the flow control permit leak was causing the consumer to stall
      actual:
        the flow control permit leak was causing the consumer to stall
      model response:
        {"clean_text":"the flow control permit leak was causing the consumer to stall","edits":[]}

  ✓ nop_003 (1023ms)
      model: gpt-4o-mini
      input:
        i want to schedule the meeting on friday
      expected:
        i want to schedule the meeting on friday
      actual:
        i want to schedule the meeting on friday
      model response:
        {"clean_text":"i want to schedule the meeting on friday","edits":[]}

  ✓ nop_005 (939ms)
      model: gpt-4o-mini
      input:
        we like the new latency numbers a lot
      expected:
        we like the new latency numbers a lot
      actual:
        we like the new latency numbers a lot
      model response:
        {"clean_text":"we like the new latency numbers a lot","edits":[]}

  ✓ ins_001 (957ms)
      model: gpt-4o-mini
      input:
        schedule it at saturday no friday
      expected:
        schedule it on friday
      actual:
        schedule it on friday
      model response:
        {"clean_text":"schedule it on friday","edits":[{"raw":"at saturday no ","replacement":"","reason":"false_start"}]}
      edits: [{"raw":"at saturday no ","replacement":"","reason":"false_start"}]
      ! valid_reconstruct: edits did not rebuild model clean_text

  ✓ ins_002 (1130ms)
      model: gpt-4o-mini
      input:
        he don't he doesn't have access yet
      expected:
        he doesn't have access yet
      actual:
         he doesn't have access yet
      model response:
        {"clean_text":"he doesn't have access yet","edits":[{"raw":"he don't","replacement":"","reason":"self_correction"}]}
      edits: [{"raw":"he don't","replacement":"","reason":"self_correction"}]

  ✓ ins_003 (1231ms)
      model: gpt-4o-mini
      input:
        there is three no four blockers left
      expected:
        there are four blockers left
      actual:
        there are four blockers left
      model response:
        {"clean_text":"there are four blockers left","edits":[{"raw":"there is three no four","replacement":"there are four","reason":"number correction"}]}
      edits: [{"raw":"there is three no four","replacement":"there are four","reason":"number correction"}]

  ✓ ins_004 (1053ms)
      model: gpt-4o-mini
      input:
        i talked to him no to them yesterday
      expected:
        i talked to them yesterday
      actual:
        i talked to them yesterday
      model response:
        {"clean_text":"i talked to them yesterday","edits":[{"raw":"no","replacement":"","reason":"self_correction"}]}
      edits: [{"raw":"no","replacement":"","reason":"self_correction"}]
      ! valid_reconstruct: edits did not rebuild model clean_text

  ✓ long_002 (1747ms)
      model: gpt-4o-mini
      input:
        the plan is to ship on friday no let me rephrase the plan is to cut the release branch on friday and ship on monday assuming uh assuming the evals pass
      expected:
        the plan is to cut the release branch on friday and ship on monday assuming the evals pass
      actual:
         the plan is to cut the release branch on friday and ship on monday assuming  the evals pass
      model response:
        {"clean_text":"the plan is to cut the release branch on friday and ship on monday assuming the evals pass","edits":[{"raw":"the plan is to ship on friday no let me rephrase","replacement":"","reason":"self_correction"},{"raw":"uh assuming","replacement":"","reason":"filler"}]}
      edits: [{"raw":"the plan is to ship on friday no let me rephrase","replacement":"","reason":"self_correction"},{"raw":"uh assuming","replacement":"","reason":"filler"}]

------------------------------------------------------------------------
FAILED — detail (2)
------------------------------------------------------------------------

  ✗ nop_004 (1146ms)
      model: gpt-4o-mini
      input:
        can you review the pull request before the standup tomorrow
      expected:
        can you review the pull request before the standup tomorrow
      actual:
        review the pull request before the standup tomorrow
      model response:
        {"clean_text":"review the pull request before the standup tomorrow","edits":[{"raw":"can you ","replacement":"","reason":"false_start"}]}
      edits: [{"raw":"can you ","replacement":"","reason":"false_start"}]
      - clean_text mismatch (expected normalized_exact)

  ✗ long_001 (2081ms)
      model: gpt-4o-mini
      input:
        so um i wanted to walk through the the architecture we have the hotkey capture layer then it streams to uh to the asr endpoint and then no wait before that there's a gate layer that checks the audio level and then it streams to the asr endpoint
      expected:
        i wanted to walk through the architecture we have the hotkey capture layer then there's a gate layer that checks the audio level and then it streams to the asr endpoint
      actual:
        i wanted to walk through the architecture we have the hotkey capture layer then it streams to the asr endpoint and then there's a gate layer that checks the audio level and then it streams to the asr endpoint
      model response:
        {"clean_text":"i wanted to walk through the architecture we have the hotkey capture layer then it streams to the asr endpoint and then there's a gate layer that checks the audio level and then it streams to the asr endpoint","edits":[{"raw":"so um ","replacement":"","reason":"filler"},{"raw":"the the","replacement":"the","reason":"repetition"},{"raw":"uh to ","replacement":"","reason":"filler"},{"raw":"no wait before that ","replacement":"","reason":"self_correction"}]}
      edits: [{"raw":"so um ","replacement":"","reason":"filler"},{"raw":"the the","replacement":"the","reason":"repetition"},{"raw":"uh to ","replacement":"","reason":"filler"},{"raw":"no wait before that ","replacement":"","reason":"self_correction"}]
      - clean_text mismatch (expected normalized_exact)

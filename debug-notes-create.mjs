/**
 * Direct test of notes.create failure
 * Isolates the error by calling the endpoint and logging full error details
 */

const response = await fetch('http://localhost:3000/trpc/notes.create?batch=1', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-test-user-id': 'test-debug-user',
  },
  body: JSON.stringify({
    0: {
      title: 'Debug Test ' + Date.now(),
      content: 'Testing error capture',
      tags: ['debug']
    }
  }),
});

const result = await response.json();
console.log('FULL ERROR RESPONSE:');
console.log(JSON.stringify(result, null, 2));

if (result[0]?.error) {
  console.log('\nERROR DETAILS:');
  console.log('Code:', result[0].error.code);
  console.log('Message:', result[0].error.message);
  console.log('Data:', JSON.stringify(result[0].error.data, null, 2));
}

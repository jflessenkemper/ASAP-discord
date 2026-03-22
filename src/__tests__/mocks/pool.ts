// Mock pg pool used by all route tests
const mockQuery = jest.fn();
const mockConnect = jest.fn();
const mockRelease = jest.fn();
const mockOn = jest.fn();

mockConnect.mockResolvedValue({
  query: mockQuery,
  release: mockRelease,
});

const pool = {
  query: mockQuery,
  connect: mockConnect,
  on: mockOn,
  end: jest.fn(),
};

export default pool;
export { mockQuery, mockConnect, mockRelease };
